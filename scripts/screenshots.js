#!/usr/bin/env node
'use strict';
/**
 * Visual verification pass: captures the app's main states in both themes
 * and at a narrow window size, into test/screenshots/ (gitignored).
 *
 * Usage: node scripts/screenshots.js
 */

const { _electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO = path.join(__dirname, '..');
const OUT = path.join(REPO, 'test', 'screenshots');
const SANDBOX = process.env.GLOSS_TEST_SANDBOX === '1' ? [] : ['--no-sandbox'];

async function shoot(name, { fixture = null, theme = 'light', width = 1280, height = 860, act = null }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-shot-'));
  const args = [...SANDBOX, `--user-data-dir=${dataDir}`, '.'];
  if (fixture) args.push(path.join(REPO, 'test', 'fixtures', fixture));

  const app = await _electron.launch({ args, cwd: REPO });
  const page = await app.firstWindow();
  await page.waitForSelector('body[data-ready="1"]', { timeout: 30_000 });
  await page.setViewportSize({ width, height });
  await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);

  if (fixture) {
    await page.waitForSelector('.pdf-page-wrapper[data-rendered="true"] canvas', { timeout: 30_000 });
    await page.waitForTimeout(500);
  }
  if (act) await act(page);
  await page.waitForTimeout(450);

  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`captured ${name}.png`);
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

const selectWord = (word) => async (page) => {
  const target = await page.evaluate((w) => {
    const span = [...document.querySelectorAll('.pdf-text-layer span')]
      .find(s => s.textContent.includes(w));
    if (!span) return null;
    const r = span.getBoundingClientRect();
    return { x: r.x + 14, y: r.y + r.height / 2 };
  }, word);
  if (!target) return;
  await page.mouse.dblclick(target.x, target.y);
  await page.waitForTimeout(1400);
};

const openSearch = (query) => async (page) => {
  await page.keyboard.press('Control+f');
  await page.fill('#search-input', query);
  await page.waitForTimeout(1500);
};

(async () => {
  await shoot('01-empty-light', { theme: 'light' });
  await shoot('02-empty-dark', { theme: 'dark' });
  await shoot('03-reading-light', { fixture: 'devanagari.pdf', theme: 'light' });
  await shoot('04-reading-dark', { fixture: 'devanagari.pdf', theme: 'dark' });
  await shoot('05-lookup-light', { fixture: 'devanagari.pdf', theme: 'light', act: selectWord('काठमाडौँ') });
  await shoot('06-lookup-dark', { fixture: 'devanagari.pdf', theme: 'dark', act: selectWord('काठमाडौँ') });
  await shoot('07-search-light', { fixture: 'devanagari.pdf', theme: 'light', act: openSearch('काठमाडौँ') });
  await shoot('08-sidebar-dark', {
    fixture: 'large.pdf', theme: 'dark',
    act: async (page) => { await page.keyboard.press('F9'); await page.waitForTimeout(1500); },
  });
  await shoot('09-prefs-light', {
    theme: 'light',
    act: async (page) => { await page.click('#btn-prefs'); await page.waitForTimeout(500); },
  });
  await shoot('10-prefs-lookup-dark', {
    theme: 'dark',
    act: async (page) => {
      await page.click('#btn-prefs');
      await page.waitForTimeout(300);
      await page.click('[data-section="lookup"]');
      await page.waitForTimeout(400);
    },
  });
  await shoot('11-narrow-light', { fixture: 'latin.pdf', theme: 'light', width: 720, height: 700 });
  await shoot('12-scanned-notice', { fixture: 'scanned.pdf', theme: 'light' });
  console.log(`\nScreenshots written to ${OUT}`);
})().catch(err => { console.error('screenshot run failed:', err.message); process.exit(1); });
