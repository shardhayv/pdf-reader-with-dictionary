'use strict';
/**
 * Layout and interaction regressions found by driving the real window.
 *
 * Each test pins a defect that shipped: a toolbar that pushed Preferences off
 * the edge of the window, Copy buttons that silently did nothing, keys that
 * reached the document through an open dialog, a zoomed page whose left edge
 * could not be scrolled to, and Print producing a handful of real pages
 * followed by hundreds of blanks.
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchGloss, resizeWindow, waitForDocument, collectErrors } = require('./helpers');

/** Twelve global glossaries with long names — a realistic full shelf. */
async function addShelf(app, page) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-shelf-'));
  const files = [];
  for (let i = 1; i <= 12; i++) {
    const file = path.join(dir, `${String(i).padStart(2, '0')}-shelf.json`);
    fs.writeFileSync(file, JSON.stringify({
      format: 'gloss-glossary', version: 1, scope: 'global',
      name: `Dictionary ${i} — Science, History & Letters`,
      entries: [{ word: 'quick', definition: `<b>quick</b> — fast (dictionary ${i}).` }],
    }));
    files.push(file);
  }
  await app.evaluate(({ dialog }, list) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: list });
  }, files);
  await page.evaluate(() => window.gloss.addDictionaries());
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('gloss:dictionaries-changed', { failed: [], warnings: [] });
  });
  await expect(page.locator('#sources-count')).toHaveText('14');
}

/** Every visible toolbar control, and whether it lies fully inside the window. */
function toolbarReport(page) {
  return page.evaluate(() => {
    const bar = document.getElementById('toolbar').getBoundingClientRect();
    const controls = [...document.querySelectorAll('#toolbar button, #toolbar select, #toolbar input, #page-total')]
      .filter(el => el.getClientRects().length > 0);
    const rects = controls.map(el => ({ id: el.id, r: el.getBoundingClientRect() }));
    const outside = rects
      .filter(({ r }) => r.left < bar.left - 0.5 || r.right > bar.right + 0.5 || r.height > bar.height)
      .map(({ id }) => id);
    const overlapping = [];
    const sorted = [...rects].sort((a, b) => a.r.left - b.r.left);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].r.left < sorted[i - 1].r.right - 0.5) overlapping.push(`${sorted[i - 1].id}|${sorted[i].id}`);
    }
    return {
      outside,
      overlapping,
      visible: rects.map(({ id }) => id),
      rows: new Set(rects.map(({ r }) => Math.round(r.top + r.height / 2))).size,
      documentOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
}

test('the toolbar stays complete and on one row from ultrawide down to the minimum window', async () => {
  const { app, page } = await launchGloss({ open: 'large.pdf' });
  try {
    await waitForDocument(page);
    await addShelf(app, page);

    for (const width of [1600, 1280, 1024, 860, 720, 600, 520, 420]) {
      await resizeWindow(app, page, width, 620);
      const report = await toolbarReport(page);
      expect(report.outside, `controls outside the toolbar at ${width}px`).toEqual([]);
      expect(report.overlapping, `overlapping controls at ${width}px`).toEqual([]);
      expect(report.documentOverflow, `horizontal overflow at ${width}px`).toBe(false);
      // The essentials never fold away.
      for (const id of ['btn-open', 'btn-sidebar', 'btn-search', 'page-input', 'page-total', 'btn-sources', 'btn-prefs']) {
        expect(report.visible, `${id} at ${width}px`).toContain(id);
      }
      // "of 300" used to wrap onto two lines.
      expect(await page.evaluate(() => document.getElementById('page-total').getClientRects().length)).toBe(1);
    }

    // At the narrowest size the folded tools are reachable through "More".
    await page.click('#btn-more');
    await expect(page.locator('#more-menu')).toBeVisible();
    await expect(page.locator('#more-menu')).toContainText('Rotate clockwise');
    await expect(page.locator('#more-menu')).toContainText('Fit page');
    const before = await page.evaluate(() => document.querySelector('.pdf-page-wrapper').offsetWidth);
    await page.click('#more-menu [data-forward="btn-rotate"]');
    await expect(page.locator('#more-menu')).toBeHidden();
    await expect.poll(() => page.evaluate(() => {
      const w = document.querySelector('.pdf-page-wrapper');
      return w.offsetWidth > w.offsetHeight;
    })).toBe(true);
    expect(before).toBeGreaterThan(0);

    // Widening brings every control back and retires the menu button.
    await resizeWindow(app, page, 1400, 620);
    await expect(page.locator('#btn-more')).toBeHidden();
    await expect(page.locator('#btn-rotate')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('lookup sources are switched from one scrolling menu, however many there are', async () => {
  const { app, page } = await launchGloss({ open: 'latin.pdf' });
  try {
    await waitForDocument(page);
    await addShelf(app, page);
    await resizeWindow(app, page, 900, 460);

    await page.click('#btn-sources');
    const menu = page.locator('#sources-menu');
    await expect(menu).toBeVisible();
    await expect(menu.locator('[data-source-path]')).toHaveCount(12);
    // The menu is confined to the window and scrolls internally.
    const box = await menu.boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(460);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(900);

    // Toggling keeps the menu open and updates the count.
    await menu.locator('[data-source-path]').first().click();
    await expect(page.locator('#sources-count')).toHaveText('13');
    await expect(menu).toBeVisible();
    await menu.locator('[data-source-wiki]').click();
    await expect(page.locator('#sources-count')).toHaveText('12');
    expect((await page.evaluate(() => window.gloss.getPrefs())).wikipediaEnabled).toBe(false);

    // Escape closes the menu only, and returns focus to its button.
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    expect(await page.evaluate(() => document.activeElement.id)).toBe('btn-sources');
    expect(await page.title()).toContain('latin.pdf');

    // "Manage" opens Preferences at the dictionary list.
    await page.click('#btn-sources');
    await page.click('[data-source-manage]');
    await expect(page.locator('#prefs-overlay')).toBeVisible();
    await expect(page.locator('.dict-row')).toHaveCount(12);
  } finally {
    await app.close();
  }
});

test('copying to the clipboard works, and saved words keep clean text', async () => {
  const { app, page } = await launchGloss({ open: 'latin.pdf' });
  const previous = await app.evaluate(({ clipboard }) => clipboard.readText());
  try {
    await waitForDocument(page);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-copy-'));
    const file = path.join(dir, 'amp.json');
    fs.writeFileSync(file, JSON.stringify({
      format: 'gloss-glossary', version: 1, scope: 'global', name: 'Arts & Letters',
      entries: [{ word: 'liminal', definition: '<p>On a <b>threshold</b>.</p><ul><li>between states</li></ul>' }],
    }));
    await app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
    }, file);
    await page.evaluate(() => window.gloss.addDictionaries());
    await page.evaluate(() => window.gloss.setPrefs({ wiktionaryEnabled: false, wikipediaEnabled: false }));

    await page.evaluate(async () => {
      const lookup = await import('./js/lookup.js');
      lookup.setPrefs(await window.gloss.getPrefs());
      lookup.invalidateDictionaries();
      await lookup.lookupSelection('liminal', { top: 200, bottom: 220, left: 200, right: 260 });
    });
    await expect(page.locator('.popup-definition')).toContainText('threshold');

    await app.evaluate(({ clipboard }) => clipboard.clear());
    await page.click('#popup-copy');
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe('liminal\nOn a threshold.\n\nbetween states');

    // Saving stores the dictionary's real name and only the definition —
    // not "Arts &amp; Letters", and not the upper-cased badge or web link.
    await page.keyboard.press('s');
    await expect.poll(async () => (await page.evaluate(() => window.gloss.getPrefs())).savedWords.length).toBe(1);
    const [saved] = (await page.evaluate(() => window.gloss.getPrefs())).savedWords;
    expect(saved.source).toBe('Arts & Letters');
    expect(saved.definition).toBe('On a threshold.\n\nbetween states');
    expect(saved.page).toBe(1);

    // Reading the clipboard stays denied to the page.
    expect(await page.evaluate(() => navigator.clipboard.readText().then(() => 'read', () => 'denied'))).toBe('denied');
  } finally {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), previous).catch(() => {});
    await app.close();
  }
});

test('keys act on the focused control, and a dialog keeps them from the document', async () => {
  const { app, page } = await launchGloss({ open: 'large.pdf' });
  try {
    await waitForDocument(page);
    const scrollTop = () => page.evaluate(() => document.getElementById('pdf-container').scrollTop);
    const boxOf = () => page.evaluate(() => {
      const w = document.querySelector('.pdf-page-wrapper');
      return `${w.offsetWidth}x${w.offsetHeight}`;
    });

    // Space presses a focused button instead of scrolling the page behind it.
    await page.focus('#btn-sidebar');
    await page.keyboard.press('Space');
    await expect(page.locator('#sidebar')).toBeVisible();
    expect(await scrollTop()).toBe(0);
    await page.keyboard.press('Space');
    await expect(page.locator('#sidebar')).toBeHidden();

    // Arrow keys belong to a focused <select>.
    await page.focus('#zoom-menu');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(400);
    expect(await page.inputValue('#page-input')).toBe('1');
    await page.keyboard.press('Control+0');

    // With the page focused, Space still reads on and Shift+Space goes back.
    await page.focus('#pdf-container');
    await page.keyboard.press('Space');
    await expect.poll(scrollTop).toBeGreaterThan(100);
    await page.keyboard.press('Shift+Space');
    await expect.poll(scrollTop).toBe(0);

    // An open dialog owns the keyboard: nothing reaches the document.
    const upright = await boxOf();
    await page.keyboard.press('Control+Comma');
    await expect(page.locator('#prefs-overlay')).toBeVisible();
    await page.keyboard.press('r');
    await page.keyboard.press('v');
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(400);
    expect(await boxOf()).toBe(upright);
    expect(await scrollTop()).toBe(0);
    expect(await page.evaluate(() => document.getElementById('pages').classList.contains('pages--spread'))).toBe(false);
    // …and the toolbar behind it cannot be focused or clicked.
    expect(await page.evaluate(() => document.querySelector('.app-shell').inert)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('#prefs-overlay')).toBeHidden();
    expect(await page.evaluate(() => document.querySelector('.app-shell').inert)).toBe(false);
    expect(await page.evaluate(() => document.activeElement.id)).toBe('pdf-container');
  } finally {
    await app.close();
  }
});

test('a zoomed page is fully reachable and zoom holds the reader\'s place deep in a book', async () => {
  const { app, page } = await launchGloss({ open: 'large.pdf' });
  try {
    await waitForDocument(page);
    await resizeWindow(app, page, 900, 640);

    // 200%: the page is wider than the window. Its left edge must be the
    // scroll origin, not somewhere off to the left of it.
    await page.selectOption('#zoom-menu', '2');
    await page.waitForTimeout(400);
    const edges = await page.evaluate(() => {
      const c = document.getElementById('pdf-container');
      const w = document.querySelector('.pdf-page-wrapper');
      c.scrollLeft = 0;
      const left = w.getBoundingClientRect().left - c.getBoundingClientRect().left;
      c.scrollLeft = c.scrollWidth;
      const right = c.getBoundingClientRect().left + c.clientWidth - w.getBoundingClientRect().right;
      return { left, right, wider: w.offsetWidth > c.clientWidth };
    });
    expect(edges.wider).toBe(true);
    expect(edges.left).toBeGreaterThanOrEqual(0);
    expect(edges.right).toBeGreaterThanOrEqual(0);

    // Two hundred pages in, a zoom step must keep the same line under the
    // centre of the window. The old scroll-ratio maths drifted ~300 px here.
    await page.selectOption('#zoom-menu', '1');
    await page.waitForTimeout(300);
    const centreFraction = () => page.evaluate(() => {
      const c = document.getElementById('pdf-container');
      const r = document.querySelector('.pdf-page-wrapper[data-page-number="200"]').getBoundingClientRect();
      const mid = c.getBoundingClientRect().top + c.clientHeight / 2;
      return { fraction: (mid - r.top) / r.height, height: r.height };
    });
    await page.evaluate(() => {
      const c = document.getElementById('pdf-container');
      c.scrollTop = document.querySelector('.pdf-page-wrapper[data-page-number="200"]').offsetTop + 180;
    });
    await page.waitForTimeout(300);
    const before = await centreFraction();
    await page.keyboard.press('Control+Equal');
    await page.waitForTimeout(300);
    const after = await centreFraction();
    expect(Math.abs(after.fraction - before.fraction) * after.height).toBeLessThan(4);
    await expect.poll(() => page.inputValue('#page-input')).toBe('200');

    // The same holds when the window itself changes size in a fit mode.
    await page.keyboard.press('Control+0');
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const c = document.getElementById('pdf-container');
      c.scrollTop = document.querySelector('.pdf-page-wrapper[data-page-number="200"]').offsetTop + 120;
    });
    await page.waitForTimeout(300);
    const topFraction = () => page.evaluate(() => {
      const c = document.getElementById('pdf-container');
      const r = document.querySelector('.pdf-page-wrapper[data-page-number="200"]').getBoundingClientRect();
      return { fraction: (c.getBoundingClientRect().top - r.top) / r.height, height: r.height };
    });
    const wide = await topFraction();
    await resizeWindow(app, page, 620, 640);
    await page.waitForTimeout(500);
    const narrow = await topFraction();
    expect(Math.abs(narrow.fraction - wide.fraction) * narrow.height).toBeLessThan(6);
  } finally {
    await app.close();
  }
});

test('the reading position survives reopening in a window of a different size', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-position-'));
  const first = await launchGloss({ open: 'large.pdf', userDataDir: dataDir });
  try {
    await waitForDocument(first.page);
    await resizeWindow(first.app, first.page, 1300, 800);
    await first.page.evaluate(() => {
      const c = document.getElementById('pdf-container');
      const w = document.querySelector('.pdf-page-wrapper[data-page-number="240"]');
      c.scrollTop = w.offsetTop + w.offsetHeight * 0.4;
    });
    await first.page.waitForTimeout(1400); // debounced save
  } finally {
    await first.app.close();
  }

  // Start the second session in a much narrower window.
  const prefsFile = path.join(dataDir, 'preferences.json');
  const prefs = JSON.parse(fs.readFileSync(prefsFile, 'utf8'));
  prefs.window = { bounds: { x: 0, y: 0, width: 640, height: 700 }, isMaximized: false };
  fs.writeFileSync(prefsFile, JSON.stringify(prefs));

  const second = await launchGloss({ open: 'large.pdf', userDataDir: dataDir });
  try {
    await waitForDocument(second.page);
    const position = await second.page.evaluate(async () => {
      const viewer = await import('./js/viewer.js');
      return viewer.readingPosition();
    });
    expect(position.page).toBe(240);
    expect(position.offset).toBeGreaterThan(0.37);
    expect(position.offset).toBeLessThan(0.43);
    expect(await second.page.inputValue('#page-input')).toBe('240');
  } finally {
    await second.app.close();
  }
});

test('printing lays out every page of the document, one per sheet', async () => {
  const { app, page } = await launchGloss({ open: 'links.pdf' });
  const errors = collectErrors(page);
  try {
    await waitForDocument(page);
    const total = Number((await page.textContent('#page-total')).replace(/\D/g, ''));
    expect(total).toBeGreaterThan(1);

    const prepared = await page.evaluate(async () => {
      const print = await import('./js/print.js');
      return print.preparePrint();
    });
    expect(prepared).toEqual({ pages: total, failed: 0 });
    expect(await page.locator('#print-root .print-page img').count()).toBe(total);

    // The print engine sees exactly those sheets, at the document's page size.
    const pdf = await app.evaluate(async ({ BrowserWindow }) => {
      const data = await BrowserWindow.getAllWindows()[0].webContents.printToPDF({ preferCSSPageSize: true });
      return data.toString('latin1');
    });
    expect((pdf.match(/\/Type\s*\/Page[^s]/g) || []).length).toBe(total);
    expect(pdf).toMatch(/\/MediaBox\s*\[\s*0\s+0\s+612(\.\d+)?\s+792(\.\d+)?\s*\]/);

    await page.evaluate(async () => (await import('./js/print.js')).clearPrint());
    expect(await page.locator('#print-root .print-page').count()).toBe(0);
    expect(errors.filter(e => /Content Security Policy|print/i.test(e))).toEqual([]);

    // A long document can be cancelled part-way and leaves nothing behind.
    await app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
    }, path.join(__dirname, '..', 'fixtures', 'large.pdf'));
    await page.click('#btn-open');
    await expect(page.locator('#page-total')).toHaveText('of 300');
    const cancelled = await page.evaluate(async () => {
      const print = await import('./js/print.js');
      const run = print.preparePrint({ onProgress: (done) => { if (done === 3) print.cancelPrint(); } });
      return run;
    });
    expect(cancelled).toBeNull();
    expect(await page.locator('#print-root .print-page').count()).toBe(0);
  } finally {
    await app.close();
  }
});

test('narrow windows float the sidebar and stack the preferences layout', async () => {
  const { app, page } = await launchGloss({ open: 'large.pdf' });
  try {
    await waitForDocument(page);
    await resizeWindow(app, page, 480, 420);

    const pageWidth = () => page.evaluate(() => document.querySelector('.pdf-page-wrapper').offsetWidth);
    const closedWidth = await pageWidth();
    await page.keyboard.press('F9');
    await expect(page.locator('#sidebar')).toBeVisible();
    await expect(page.locator('#sidebar-scrim')).toBeVisible();
    // Floating: the page keeps its full width under the sidebar.
    expect(await pageWidth()).toBe(closedWidth);
    await page.keyboard.press('Escape');
    await expect(page.locator('#sidebar')).toBeHidden();

    // Preferences fits the window with no sideways scrolling.
    await page.click('#btn-prefs');
    const modal = await page.locator('#prefs-modal').boundingBox();
    expect(modal.x).toBeGreaterThanOrEqual(0);
    expect(modal.x + modal.width).toBeLessThanOrEqual(480);
    expect(modal.y + modal.height).toBeLessThanOrEqual(420);
    expect(await page.evaluate(() => {
      const body = document.getElementById('prefs-body');
      return body.scrollWidth <= body.clientWidth;
    })).toBe(true);
    await page.click('[data-section="appearance"]');
    await expect(page.locator('#prefs-body')).toContainText('Interface theme');
  } finally {
    await app.close();
  }
});

test('the definition popup never covers the word it explains, even in a short window', async () => {
  const { app, page } = await launchGloss({ open: 'large.pdf' });
  try {
    await waitForDocument(page);
    await page.evaluate(() => window.gloss.setPrefs({ wiktionaryEnabled: false, wikipediaEnabled: false }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-tall-'));
    const file = path.join(dir, 'tall.json');
    fs.writeFileSync(file, JSON.stringify({
      format: 'gloss-glossary', version: 1, scope: 'global', name: 'Tall definitions',
      entries: [{
        word: 'quick',
        definition: `<ol>${Array.from({ length: 30 }, (_, i) => `<li>sense number ${i + 1} of a long entry</li>`).join('')}</ol>`,
      }],
    }));
    await app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
    }, file);
    await page.evaluate(() => window.gloss.addDictionaries());

    const overlap = async (anchor) => page.evaluate(async (rect) => {
      const lookup = await import('./js/lookup.js');
      const popupModule = await import('./js/popup.js');
      popupModule.closePopup({ force: true });
      lookup.setPrefs(await window.gloss.getPrefs());
      lookup.invalidateDictionaries();
      await lookup.lookupSelection('quick', rect);
      await new Promise(resolve => setTimeout(resolve, 150));
      const p = document.getElementById('popup').getBoundingClientRect();
      const covered = !(p.right <= rect.left || p.left >= rect.right || p.bottom <= rect.top || p.top >= rect.bottom);
      return {
        covered,
        inside: p.left >= 0 && p.top >= 0 && p.right <= innerWidth && p.bottom <= innerHeight,
        scrolls: document.getElementById('popup-body').scrollHeight > document.getElementById('popup-body').clientHeight,
      };
    }, anchor);

    // Wide but short: the popup goes beside the word.
    await resizeWindow(app, page, 1000, 420);
    const beside = await overlap({ top: 200, bottom: 222, left: 180, right: 240 });
    expect(beside).toEqual({ covered: false, inside: true, scrolls: true });

    // Narrow and short: no room beside, so it takes the roomier side, capped.
    await resizeWindow(app, page, 440, 420);
    const capped = await overlap({ top: 250, bottom: 272, left: 150, right: 210 });
    expect(capped).toEqual({ covered: false, inside: true, scrolls: true });

    // Plenty of room: straight below, as always.
    await resizeWindow(app, page, 1000, 900);
    const roomy = await overlap({ top: 120, bottom: 142, left: 180, right: 240 });
    expect(roomy.covered).toBe(false);
    expect(roomy.inside).toBe(true);
  } finally {
    await app.close();
  }
});
