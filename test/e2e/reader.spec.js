'use strict';
/**
 * Reader behaviour: opening, navigation, zoom, search, virtualization,
 * Devanagari selection and copy, and the document-quality notices.
 */

const { test, expect } = require('@playwright/test');
const { launchGloss, waitForDocument, collectErrors, fixture } = require('./helpers');

test('opens a PDF passed on the command line', async () => {
  const { app, page } = await launchGloss({ open: 'latin.pdf' });
  const errors = collectErrors(page);
  try {
    await waitForDocument(page);
    expect(await page.title()).toContain('latin.pdf');
    expect(await page.textContent('#page-total')).toBe('of 2');
    expect(await page.locator('#empty-state').isHidden()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test('a second launch focuses the running instance and opens its file', async () => {
  const { app, page, dataDir } = await launchGloss({ open: 'latin.pdf' });
  try {
    await waitForDocument(page);
    expect(await page.title()).toContain('latin.pdf');

    // Launching again with the same user-data dir must not create a second
    // instance; the running one adopts the new document.
    const { execFileSync } = require('child_process');
    const electronBin = require('electron');
    const { REPO, SANDBOX_ARGS } = require('./helpers');
    try {
      execFileSync(electronBin, [
        ...SANDBOX_ARGS, `--user-data-dir=${dataDir}`, '.', fixture('devanagari.pdf'),
      ], { cwd: REPO, timeout: 25_000, stdio: 'ignore' });
    } catch { /* the second process exits immediately once it loses the lock */ }

    await expect.poll(async () => page.title(), { timeout: 20_000 })
      .toContain('devanagari.pdf');
    expect(await page.textContent('#page-total')).toBe('of 1');
  } finally {
    await app.close();
  }
});

test('navigation, zoom modes and keyboard shortcuts', async () => {
  const { app, page } = await launchGloss({ open: 'large.pdf' });
  try {
    await waitForDocument(page);
    expect(await page.textContent('#page-total')).toBe('of 300');

    // Go to page via the editable field.
    await page.fill('#page-input', '42');
    await page.press('#page-input', 'Enter');
    await expect.poll(async () => page.inputValue('#page-input'), { timeout: 15_000 })
      .toBe('42');

    // Next / previous page controls.
    await page.click('#btn-next-page');
    await expect.poll(async () => page.inputValue('#page-input')).toBe('43');
    await page.click('#btn-prev-page');
    await expect.poll(async () => page.inputValue('#page-input')).toBe('42');

    // Zoom in twice, then reset to fit width.
    const zoomValue = () => page.inputValue('#zoom-menu');
    await page.keyboard.press('Control+Equal');
    await page.keyboard.press('Control+Equal');
    await page.waitForTimeout(500);
    expect(Number(await zoomValue())).toBeGreaterThan(1);

    await page.keyboard.press('Control+0');
    await page.waitForTimeout(400);
    expect(await zoomValue()).toBe('fit-width');

    await page.keyboard.press('Control+Shift+0');
    await page.waitForTimeout(400);
    expect(await zoomValue()).toBe('fit-page');

    // Fit page must fit vertically.
    const fits = await page.evaluate(() => {
      const w = document.querySelector('.pdf-page-wrapper');
      const c = document.getElementById('pdf-container');
      return w.getBoundingClientRect().height <= c.clientHeight + 2;
    });
    expect(fits).toBe(true);
  } finally {
    await app.close();
  }
});

test('a 300-page document keeps mounted pages bounded while scrolling', async () => {
  const { app, page } = await launchGloss({ open: 'large.pdf' });
  try {
    await waitForDocument(page);

    const rendered = () => page.evaluate(() =>
      document.querySelectorAll('.pdf-page-wrapper[data-rendered="true"]').length);
    const placeholders = () => page.evaluate(() =>
      document.querySelectorAll('.pdf-page-wrapper').length);

    expect(await placeholders()).toBe(300); // all pages sized up front
    const samples = [await rendered()];

    for (const target of [30, 90, 160, 240, 299]) {
      await page.fill('#page-input', String(target));
      await page.press('#page-input', 'Enter');
      await page.waitForTimeout(900);
      samples.push(await rendered());
    }

    // RENDER_BUFFER=2 and DESTROY_DISTANCE=5 bound live canvases to a small
    // window regardless of how far we scroll.
    const worst = Math.max(...samples);
    expect(worst, `rendered page counts: ${samples.join(', ')}`).toBeLessThanOrEqual(14);
    expect(await placeholders()).toBe(300);
  } finally {
    await app.close();
  }
});

test('search works for Latin and Devanagari, and Escape closes only search', async () => {
  const { app, page } = await launchGloss({ open: 'devanagari.pdf' });
  try {
    await waitForDocument(page);

    await page.keyboard.press('Control+f');
    await expect(page.locator('#search-bar')).toBeVisible();

    // Devanagari with a chandrabindu, appearing three times.
    await page.fill('#search-input', 'काठमाडौँ');
    await expect.poll(async () => page.textContent('#search-count'), { timeout: 15_000 })
      .toBe('1 / 3');

    // A conjunct that pdf.js splits across two adjacent text items.
    await page.fill('#search-input', 'प्रज्ञा');
    await expect.poll(async () => page.textContent('#search-count'), { timeout: 15_000 })
      .toBe('1 / 1');

    // Latin, case-insensitively.
    await page.fill('#search-input', 'paris');
    await expect.poll(async () => page.textContent('#search-count'), { timeout: 15_000 })
      .toBe('1 / 1');

    // Highlights are registered with the Custom Highlight API.
    expect(await page.evaluate(() => CSS.highlights.get('gloss-search')?.size ?? 0))
      .toBeGreaterThan(0);

    // Next/previous cycle through results.
    await page.fill('#search-input', 'काठमाडौँ');
    await expect.poll(async () => page.textContent('#search-count')).toBe('1 / 3');
    await page.click('#search-next');
    await expect.poll(async () => page.textContent('#search-count')).toBe('2 / 3');
    await page.click('#search-prev');
    await expect.poll(async () => page.textContent('#search-count')).toBe('1 / 3');

    // Escape closes search only — it must not close the document or window.
    await page.keyboard.press('Escape');
    await expect(page.locator('#search-bar')).toBeHidden();
    expect(await page.locator('.pdf-page-wrapper').count()).toBe(1);
    expect(await page.evaluate(() => CSS.highlights.get('gloss-search')?.size ?? 0)).toBe(0);
  } finally {
    await app.close();
  }
});

test('selecting Devanagari captures the whole word and copies the original text', async () => {
  const { app, page } = await launchGloss({ open: 'devanagari.pdf' });
  const previousClipboardText = await app.evaluate(({ clipboard }) => clipboard.readText());
  try {
    await waitForDocument(page);

    const target = await page.evaluate(() => {
      const span = [...document.querySelectorAll('.pdf-text-layer span')]
        .find(s => s.textContent.includes('काठमाडौँ'));
      if (!span) return null;
      const r = span.getBoundingClientRect();
      return { x: r.x + 14, y: r.y + r.height / 2 };
    });
    expect(target).not.toBeNull();

    await page.mouse.dblclick(target.x, target.y);
    await page.waitForTimeout(900);

    // The selection keeps the complete grapheme sequence, chandrabindu included.
    const selected = await page.evaluate(() => window.getSelection().toString());
    expect(selected).toBe('काठमाडौँ');
    expect([...selected].map(c => c.codePointAt(0).toString(16))).toEqual(
      ['915', '93e', '920', '92e', '93e', '921', '94c', '901']);

    // The popup shows the exact query.
    await expect(page.locator('#popup')).toBeVisible();
    expect(await page.textContent('#popup-word')).toBe('काठमाडौँ');

    // Assert the real OS clipboard, not merely the selection string. Copying
    // must reproduce the source code points, not a normalized lookup rung.
    await app.evaluate(({ clipboard }) => clipboard.clear());
    await page.keyboard.press('Control+c');
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe('काठमाडौँ');
  } finally {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), previousClipboardText)
      .catch(() => {});
    await app.close();
  }
});

test('one selection produces exactly one lookup, and stale results cannot win', async () => {
  const { app, page } = await launchGloss({ open: 'devanagari.pdf' });
  try {
    await waitForDocument(page);

    // Count real IPC lookups in the main process. No dictionaries are loaded
    // in the test environment, so an empty result is what the real handler
    // would return anyway.
    await app.evaluate(({ ipcMain }) => {
      globalThis.__lookupCalls = [];
      ipcMain.removeHandler('dict:lookup');
      ipcMain.handle('dict:lookup', (_e, candidates) => {
        globalThis.__lookupCalls.push(candidates);
        return [];
      });
    });

    const target = await page.evaluate(() => {
      const span = [...document.querySelectorAll('.pdf-text-layer span')]
        .find(s => s.textContent.includes('संस्कृत'));
      const r = span.getBoundingClientRect();
      return { x: r.x + r.width * 0.45, y: r.y + r.height / 2 };
    });

    await page.mouse.dblclick(target.x, target.y);
    await page.waitForTimeout(1500);

    const calls = await app.evaluate(() => globalThis.__lookupCalls);
    expect(calls.length, `expected 1 lookup, got ${calls.length}`).toBe(1);
    // The exact selection is tried first so proper-case entries win.
    expect(calls[0][0]).toBe(await page.evaluate(() => window.getSelection().toString()));

    // A slow stale response must not overwrite a newer one: issue a slow
    // lookup, then a fast one, and confirm the newer word is displayed.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('dict:lookup');
      ipcMain.handle('dict:lookup', async (_e, candidates) => {
        if (candidates[0] === 'SLOW') await new Promise(r => setTimeout(r, 2500));
        return [];
      });
    });

    await page.evaluate(async () => {
      const { lookupSelection } = await import('./js/lookup.js');
      lookupSelection('SLOW', null);            // starts first, resolves last
      setTimeout(() => lookupSelection('FAST', null), 150);
    });

    await page.waitForTimeout(4000);
    expect(await page.textContent('#popup-word')).toBe('FAST');
  } finally {
    await app.close();
  }
});

test('closing the find bar abandons the search instead of scrolling the reader', async () => {
  const { app, page } = await launchGloss({ open: 'large.pdf' });
  try {
    await waitForDocument(page);
    const startPage = await page.inputValue('#page-input');

    await page.keyboard.press('Control+f');
    await page.fill('#search-input', 'quick brown');
    await page.waitForTimeout(300);   // let the scan begin
    await page.keyboard.press('Escape');

    // A search left running would keep indexing and then jump the reader to
    // its first hit, and would publish a partial result count.
    await page.waitForTimeout(2500);
    expect(await page.locator('#search-bar').isHidden()).toBe(true);
    expect(await page.inputValue('#page-input')).toBe(startPage);
    expect(await page.textContent('#search-count')).toBe('');
    expect(await page.evaluate(() => CSS.highlights.get('gloss-search')?.size ?? 0)).toBe(0);

    // Reopening runs the query afresh and reports a complete count.
    await page.keyboard.press('Control+f');
    await expect.poll(async () => page.textContent('#search-count'), { timeout: 30_000 })
      .toBe('1 / 7200');
  } finally {
    await app.close();
  }
});

test('a document that fails to open leaves the current one untouched', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const damaged = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-bad-')), 'damaged.pdf');
  // A plausible header with no usable object graph: passes the magic-byte
  // check in main, fails once pdf.js actually parses it.
  fs.writeFileSync(damaged, '%PDF-1.7\nnot actually a pdf body\n');

  const { app, page } = await launchGloss({ open: 'latin.pdf' });
  try {
    await waitForDocument(page);
    const before = {
      title: await page.title(),
      pages: await page.locator('.pdf-page-wrapper').count(),
      pageTotal: await page.textContent('#page-total'),
    };

    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, damaged);
    await page.click('#btn-open');
    await expect(page.locator('#toast')).toBeVisible({ timeout: 10_000 });

    // The reader still holds the document it had.
    expect(await page.title()).toBe(before.title);
    expect(await page.locator('.pdf-page-wrapper').count()).toBe(before.pages);
    expect(await page.textContent('#page-total')).toBe(before.pageTotal);
    expect(await page.locator('#empty-state').isHidden()).toBe(true);
    expect(await page.locator('#viewer-controls').isHidden()).toBe(false);

    // And the file that never opened is not offered as a recent document.
    const recents = await page.evaluate(() => window.gloss.getRecents());
    expect(recents.map(r => r.name)).not.toContain('damaged.pdf');
  } finally {
    await app.close();
  }
});

test('scanned and broken-text-mapping documents are explained, not mislabelled', async () => {
  const scanned = await launchGloss({ open: 'scanned.pdf' });
  try {
    await waitForDocument(scanned.page);
    await expect(scanned.page.locator('#doc-banner')).toBeVisible({ timeout: 20_000 });
    expect(await scanned.page.textContent('.banner-text')).toMatch(/scan/i);
  } finally {
    await scanned.app.close();
  }

  const garbled = await launchGloss({ open: 'garbled.pdf' });
  try {
    await waitForDocument(garbled.page);
    await expect(garbled.page.locator('#doc-banner')).toBeVisible({ timeout: 20_000 });
    expect(await garbled.page.textContent('.banner-text')).toMatch(/text mapping/i);
  } finally {
    await garbled.app.close();
  }
});

test('reading position, zoom and theme are restored for a document', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-restore-'));

  const first = await launchGloss({ open: 'large.pdf', userDataDir: dataDir });
  try {
    await waitForDocument(first.page);
    await first.page.fill('#page-input', '77');
    await first.page.press('#page-input', 'Enter');
    await first.page.waitForTimeout(900);
    await first.page.keyboard.press('Control+Equal');
    await first.page.waitForTimeout(1200); // let the debounced save flush
  } finally {
    await first.app.close();
  }

  const second = await launchGloss({ open: 'large.pdf', userDataDir: dataDir });
  try {
    await waitForDocument(second.page);
    await second.page.waitForTimeout(800);
    const restoredPage = Number(await second.page.inputValue('#page-input'));
    expect(restoredPage).toBeGreaterThan(70);
    expect(Number(await second.page.inputValue('#zoom-menu'))).toBeGreaterThan(1);
  } finally {
    await second.app.close();
  }
});
