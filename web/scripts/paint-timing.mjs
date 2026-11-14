#!/usr/bin/env node
// Time to first meaningful paint on Explore and Compare, in a fresh headless Chromium.
//   Explore: first sky tile image fully loaded (a HiPS tile request finishes).
//   Compare: the first cutout image in the viewer is decoded and visible.
//   node scripts/paint-timing.mjs [runs]
import puppeteer from 'puppeteer-core';

const BASE = (process.env.BASE || 'http://localhost:5173').replace(/\/$/, '');
const RUNS = parseInt(process.argv[2] || '3', 10);
const COMPARE = '/compare?ra=179.8&dec=1.101&a=2025W21_1B_0345_1_D2.dr1&b=2025W21_2C_0020_1_D2.dr1&mode=blink';

async function once(browser, path, kind) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1366, height: 820 });
  let tile = null;
  const t0 = Date.now();
  page.on('requestfinished', (r) => {
    if (tile === null && kind === 'explore' && /Norder\d+\/(Dir\d+\/Npix\d+|Allsky)\.(jpg|png|webp)/.test(r.url())) tile = Date.now() - t0;
  });
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const dcl = Date.now() - t0;
  let paint = null;
  if (kind === 'explore') {
    const end = Date.now() + 60000;
    while (tile === null && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    paint = tile;
  } else {
    await page
      .waitForFunction(() => [...document.querySelectorAll('.frame img')].some((i) => i.complete && i.naturalWidth > 0), { timeout: 60000, polling: 50 })
      .then(() => (paint = Date.now() - t0))
      .catch(() => {});
  }
  await ctx.close();
  return { dcl, paint };
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/chromium',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run', '--disable-dev-shm-usage'],
});
for (const [name, path, kind] of [['Explore', '/?ra=83.82&dec=-5.39', 'explore'], ['Compare', COMPARE, 'compare']]) {
  const res = [];
  for (let i = 0; i < RUNS; i++) res.push(await once(browser, path, kind));
  const med = (k) => res.map((r) => r[k] ?? Infinity).sort((a, b) => a - b)[Math.floor(res.length / 2)];
  console.log(`${name}: DOMContentLoaded ${med('dcl')} ms, first meaningful paint ${med('paint')} ms (median of ${RUNS}; runs ${res.map((r) => r.paint).join(', ')})`);
}
await browser.close();
