#!/usr/bin/env node
// Smoke test: open every route and every preset from /api/presets in headless
// Chromium and fail on any page error, console error or error panel.
//
//   node scripts/smoke.mjs                         # app at http://localhost:5173
//   BASE=http://localhost:4173 node scripts/smoke.mjs
//
// It never waits on a job: each page gets a short fixed settle time.
import puppeteer from 'puppeteer-core';

const BASE = (process.env.BASE || 'http://localhost:5173').replace(/\/$/, '');
const SETTLE = parseInt(process.env.SETTLE || '2500', 10);
const TARGET = 'ra=180&dec=0';
// Messages that are not ours to fix. Keep this list short and exact.
const ALLOW = [
  /Failed to load resource: the server responded with a status of 50[234]/, // IRSA busy behind a cutout request
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/chromium',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-first-run', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1366, height: 820 });
let where = '';
page.on('pageerror', (e) => problems.push(`${where}: pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (ALLOW.some((r) => r.test(t))) return;
  problems.push(`${where}: console error: ${t}`);
});

async function check(label) {
  const bad = await page.evaluate(() => {
    const p = document.querySelector('.err-panel');
    const root = document.getElementById('root');
    return p ? `error panel: ${p.textContent?.slice(0, 160)}` : !root || root.children.length === 0 ? 'blank page' : '';
  });
  if (bad) problems.push(`${label}: ${bad}`);
}

// Leave the previous page first: slow cutout requests from it would otherwise
// hold the browser's connections until the next document arrives.
const blank = () => page.goto('about:blank');

async function visit(path) {
  where = path;
  await blank();
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(SETTLE);
  await check(path);
  console.log(`ok   ${path}`);
}

try {
  // Plain routes (no target), then the target routes with a target.
  for (const r of ['/', '/timeline', '/compare', '/movers', '/track', '/spectrum', '/docs', '/about', '/lab']) await visit(r);
  // Reset the remembered target between the two passes.
  await page.evaluate(() => localStorage.clear());
  for (const r of ['/', '/timeline', '/compare', '/movers', '/spectrum']) await visit(`${r}?${TARGET}`);
  await visit(`/compare?${TARGET}&mode=diff`);
  await visit(`/compare?${TARGET}&mode=flip`);

  // Every preset, opened the way a visitor does: from the Explore list.
  const res = await fetch(`${BASE}/api/presets`);
  const presets = (await res.json()).presets || [];
  for (let i = 0; i < presets.length; i++) {
    where = `preset ${presets[i].id}`;
    await blank();
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('.preset', { timeout: 15000 });
    const buttons = await page.$$('.preset');
    if (!buttons[i]) {
      problems.push(`${where}: preset button missing`);
      continue;
    }
    await buttons[i].click();
    await sleep(SETTLE + 1000);
    await check(where);
    console.log(`ok   preset ${presets[i].id} -> ${new URL(page.url()).pathname}`);
  }

  // State survives page changes and a reload.
  where = 'state';
  await page.goto(`${BASE}/compare?${TARGET}`, { waitUntil: 'domcontentloaded' });
  await sleep(SETTLE);
  await page.goto(`${BASE}/docs`, { waitUntil: 'domcontentloaded' });
  await sleep(500);
  await page.goto(`${BASE}/compare`, { waitUntil: 'domcontentloaded' });
  await sleep(1500);
  const url = page.url();
  if (!url.includes('ra=180')) problems.push(`state: target lost after reload (${url})`);
  else console.log('ok   target kept across pages and reload');
} catch (e) {
  problems.push(`${where}: ${e.message}`);
} finally {
  await browser.close();
}

if (problems.length) {
  console.error(`\nSMOKE FAILED (${problems.length}):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log('\nSMOKE OK');
