#!/usr/bin/env node
// Capture every Wanderer screen in dark and light theme, at desktop (1440x900) and phone
// (390x844) size, into public/docs/shots/. Uses the system Chromium; no browser download.
//
//   node scripts/shots.mjs                       # app at http://localhost:5173 (real gateway)
//   BASE=http://localhost:5174 MOCK=1 node scripts/shots.mjs   # against the mock layer
//   ONLY=compare-blink,track node scripts/shots.mjs            # a subset
//
// Targets can be overridden: TARGET="ra=180&dec=0", DEEP="ra=270.2&dec=66.6", TRACK="3I/ATLAS",
// SPEC="ra=148.9685&dec=69.6797&name=M82".
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(root, 'public', 'docs', 'shots');
const BASE = (process.env.BASE || 'http://localhost:5173').replace(/\/$/, '');
const MOCK = process.env.MOCK === '1';
const TARGET = process.env.TARGET || 'ra=180&dec=0';
const DEEP = process.env.DEEP || 'ra=270.2&dec=66.6&coll=spherex_dr1_deep';
const TRACK = process.env.TRACK || '3I/ATLAS';
const SPEC = process.env.SPEC || 'ra=148.9685&dec=69.6797&name=M82';
const SLOW = MOCK ? 1 : 6; // real data is fetched from IRSA and is much slower
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function framesReady(page, timeout) {
  // Wait until no image panel shows its loading overlay.
  await page
    .waitForFunction(() => document.querySelectorAll('.frame').length > 0 && document.querySelectorAll('.frame .loading').length === 0, { timeout, polling: 500 })
    .catch(() => console.warn('   (frames still loading, capturing anyway)'));
}
async function clickButton(page, text) {
  await page.evaluate((t) => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent && x.textContent.trim().startsWith(t) && !x.disabled);
    b?.click();
  }, text);
}
async function waitText(page, sel, timeout) {
  await page.waitForSelector(sel, { timeout }).catch(() => console.warn(`   (no ${sel} after ${timeout} ms)`));
}

const SCREENS = [
  { id: 'explore', path: `/?${TARGET}`, ready: async (p) => sleep(4000 * (MOCK ? 1 : 2)) },
  { id: 'timeline', path: `/timeline?${TARGET}`, ready: async (p) => { await waitText(p, '.tl-svg .pt', 30000 * SLOW); await clickButton(p, 'Best pair: next day'); await sleep(1500); } },
  { id: 'compare-blink', path: `/compare?${TARGET}&mode=blink&pair=short`, ready: async (p) => { await framesReady(p, 30000 * SLOW); await sleep(500); } },
  { id: 'compare-side', path: `/compare?${TARGET}&mode=side&pair=short`, ready: async (p) => { await framesReady(p, 30000 * SLOW); await sleep(500); } },
  { id: 'compare-diff', path: `/compare?${TARGET}&mode=diff&pair=short`, ready: async (p) => { await framesReady(p, 30000 * SLOW); await sleep(500); } },
  {
    id: 'compare-flip',
    path: `/compare?${DEEP}&mode=flip`,
    ready: async (p) => {
      await framesReady(p, 30000 * SLOW);
      await p.evaluate(() => {
        const t = [...document.querySelectorAll('button[role="switch"]')].find((b) => b.textContent?.includes('Mark known'));
        if (t && t.getAttribute('aria-checked') !== 'true') t.click();
      });
      await sleep(3000 * SLOW);
      await clickButton(p, 'Pause');
      await framesReady(p, 20000 * SLOW);
    },
  },
  { id: 'movers', path: `/movers?${TARGET}`, ready: async (p) => { await sleep(1500); await clickButton(p, 'Find movers'); await waitText(p, 'table.data tbody tr', 60000 * SLOW); await framesReady(p, 20000 * SLOW); } },
  { id: 'track', path: `/track?name=${encodeURIComponent(TRACK)}`, ready: async (p) => { await waitText(p, '.stamps .stamp', 60000 * SLOW); await sleep(3000 * (MOCK ? 1 : 3)); await clickButton(p, 'Pause'); } },
  { id: 'spectrum', path: `/spectrum?${SPEC}`, ready: async (p) => { await sleep(800); await clickButton(p, 'Build spectrum'); await waitText(p, '.chart-svg circle', 90000 * SLOW); await sleep(500); } },
  { id: 'docs', path: '/docs', ready: async () => sleep(800) },
  {
    id: 'focus',
    path: `/compare?${TARGET}&mode=blink&pair=short`,
    viewportOnly: true,
    ready: async (p, vp) => {
      await framesReady(p, 30000 * SLOW);
      await clickButton(p, 'Pause');
      const on = await p.$eval('[data-focus-toggle]', (e) => e.getAttribute('aria-pressed'));
      if (on !== 'true') await p.click('[data-focus-toggle]');
      if (vp.mobile) await p.tap('button[role="tab"]:nth-child(4)');
      else await p.hover('button[role="tab"]:nth-child(4)');
      await sleep(500);
    },
    after: async (p) => p.evaluate(() => localStorage.removeItem('wanderer.state')),
  },
  { id: 'about', path: '/about', ready: async () => sleep(500) },
];

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, mobile: false, maxH: 1500 },
  { name: 'mobile', width: 390, height: 844, mobile: true, maxH: 2400 },
];

mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM || '/usr/bin/chromium',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars', '--no-first-run', '--disable-dev-shm-usage'],
});

let n = 0;
try {
  for (const s of SCREENS) {
    if (ONLY && !ONLY.includes(s.id)) continue;
    for (const theme of ['dark', 'light']) {
      for (const vp of VIEWPORTS) {
        const page = await browser.newPage();
        await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1, isMobile: vp.mobile, hasTouch: vp.mobile });
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
        const sep = s.path.includes('?') ? '&' : '?';
        const url = `${BASE}${s.path}${sep}theme=${theme}${MOCK ? '&mock=1' : ''}`;
        const file = join(OUT, `${s.id}-${theme}-${vp.name}.png`);
        process.stdout.write(`-> ${s.id} ${theme} ${vp.name} ... `);
        try {
          await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
          await s.ready(page, vp);
          if (s.viewportOnly) await page.screenshot({ path: file });
          else {
            const h = await page.evaluate(() => document.documentElement.scrollHeight);
            await page.screenshot({ path: file, clip: { x: 0, y: 0, width: vp.width, height: Math.min(h, vp.maxH) }, captureBeyondViewport: true });
          }
          if (s.after) await s.after(page);
          n++;
          console.log('ok');
        } catch (e) {
          console.log(`failed: ${e.message}`);
        }
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
}
console.log(`${n} screenshots in ${OUT}`);
