#!/usr/bin/env node
'use strict';
/**
 * Performance measurements on the current machine. Reports numbers; makes no
 * claims. Run: node scripts/perf.js
 */

const { _electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO = path.join(__dirname, '..');
const SANDBOX = process.env.GLOSS_TEST_SANDBOX === '1' ? [] : ['--no-sandbox'];

async function launch(fixture) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-perf-'));
  const t0 = Date.now();
  const app = await _electron.launch({
    args: [...SANDBOX, `--user-data-dir=${dataDir}`, '.',
      path.join(REPO, 'test', 'fixtures', fixture)],
    cwd: REPO,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('body[data-ready="1"]', { timeout: 30_000 });
  const ready = Date.now() - t0;
  await page.waitForSelector('.pdf-page-wrapper[data-rendered="true"] canvas', { timeout: 30_000 });
  const firstPage = Date.now() - t0;
  await page.setViewportSize({ width: 1280, height: 860 });
  return { app, page, dataDir, ready, firstPage };
}

const ms = (n) => `${Math.round(n)} ms`;

(async () => {
  console.log('Gloss performance — this machine, development build\n');

  // ── Startup ────────────────────────────────────────────────────────────────
  const small = await launch('latin.pdf');
  console.log('Startup (2-page document)');
  console.log(`  launch to UI ready     ${ms(small.ready)}`);
  console.log(`  launch to first page   ${ms(small.firstPage)}`);
  await small.app.close();

  const big = await launch('large.pdf');
  console.log('\nStartup (300-page document)');
  console.log(`  launch to UI ready     ${ms(big.ready)}`);
  console.log(`  launch to first page   ${ms(big.firstPage)}`);

  const { page, app } = big;

  // ── Scroll smoothness ─────────────────────────────────────────────────────
  await page.evaluate(() => {
    window.__frames = [];
    let last = performance.now();
    window.__stop = false;
    const tick = (t) => {
      window.__frames.push(t - last);
      last = t;
      if (!window.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.mouse.move(640, 500);
  for (let i = 0; i < 40; i++) {
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(45);
  }
  const frames = await page.evaluate(() => { window.__stop = true; return window.__frames; });
  const sorted = [...frames].sort((a, b) => a - b);
  const long = frames.filter(f => f > 33).length;
  console.log('\nScrolling 300-page document (40 wheel bursts)');
  console.log(`  frames sampled         ${frames.length}`);
  console.log(`  median frame           ${ms(sorted[Math.floor(sorted.length / 2)])}`);
  console.log(`  95th percentile        ${ms(sorted[Math.floor(sorted.length * 0.95)])}`);
  console.log(`  frames over 33 ms      ${long} (${((long / frames.length) * 100).toFixed(1)}%)`);

  // ── Bounded mounting ───────────────────────────────────────────────────────
  const mounted = [];
  for (const target of [1, 60, 150, 220, 300]) {
    await page.fill('#page-input', String(target));
    await page.press('#page-input', 'Enter');
    await page.waitForTimeout(800);
    mounted.push(await page.evaluate(() =>
      document.querySelectorAll('.pdf-page-wrapper[data-rendered="true"]').length));
  }
  console.log('\nMounted canvases while jumping across the document');
  console.log(`  live pages             ${mounted.join(', ')} (of 300)`);

  const metrics = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics());
  const totalMb = metrics.reduce((sum, m) => sum + (m.memory?.workingSetSize || 0), 0) / 1024;
  console.log(`  total working set      ${totalMb.toFixed(0)} MB across ${metrics.length} processes`);

  // ── Zoom ───────────────────────────────────────────────────────────────────
  const zoomStart = Date.now();
  await page.keyboard.press('Control+Equal');
  await page.waitForTimeout(400);
  console.log(`\nZoom step (visual response + re-render)  ${ms(Date.now() - zoomStart)}`);

  // ── Search ─────────────────────────────────────────────────────────────────
  // The counter must be cleared before each run, otherwise the previous
  // result satisfies the wait immediately and the timing is meaningless.
  async function timeSearch(query) {
    await page.evaluate(() => { document.getElementById('search-count').textContent = ''; });
    const t = Date.now();
    await page.fill('#search-input', query);
    await page.waitForFunction(() => {
      const text = document.getElementById('search-count').textContent;
      return text && !text.startsWith('Searching');
    }, { timeout: 90_000 });
    return { ms: Date.now() - t, result: await page.textContent('#search-count') };
  }

  await page.keyboard.press('Control+f');
  console.log('\nFind in a 300-page document');
  const first = await timeSearch('quick brown');
  console.log(`  first search (cold)    ${ms(first.ms)}  (${first.result})`);
  const second = await timeSearch('lazy dog');
  console.log(`  second search (warm)   ${ms(second.ms)}  (${second.result})`);
  const miss = await timeSearch('serendipity');
  console.log(`  search with no hits    ${ms(miss.ms)}  (${miss.result})`);

  await app.close();

  // ── Lookup latency ─────────────────────────────────────────────────────────
  const deva = await launch('devanagari.pdf');
  const local = await deva.page.evaluate(async () => {
    const { lookupSelection, setPrefs } = await import('./js/lookup.js');
    setPrefs({ wikipediaEnabled: false });
    const t = performance.now();
    await lookupSelection('काठमाडौँ', null);
    return performance.now() - t;
  });
  const withWiki = await deva.page.evaluate(async () => {
    const { lookupSelection, setPrefs, clearCache } = await import('./js/lookup.js');
    setPrefs({ wikipediaEnabled: true, wikipediaAsFallback: true });
    clearCache();
    const t = performance.now();
    await lookupSelection('काठमाडौँ', null);
    return performance.now() - t;
  });
  console.log('\nLookup latency (selection to displayed result)');
  console.log(`  local only             ${ms(local)}  (no dictionaries loaded here; this is pipeline overhead)`);
  console.log(`  with Wikipedia         ${ms(withWiki)}  (includes one network round trip)`);
  await deva.app.close();

  console.log('\nMeasured on:', os.cpus().length, 'cores,',
    (os.totalmem() / 1024 ** 3).toFixed(0) + ' GB RAM,', os.release());
})().catch(err => { console.error('perf run failed:', err.message); process.exit(1); });
