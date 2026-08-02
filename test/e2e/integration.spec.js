'use strict';
/**
 * Remaining integration paths: the file dialog, drag-and-drop, recent
 * documents, reduced motion, keyboard accessibility, and the password UI.
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { launchGloss, waitForDocument, fixture, FIXTURES } = require('./helpers');

test('the Open dialog feeds the same pipeline as every other entry point', async () => {
  const { app, page } = await launchGloss();
  try {
    // Answer the native dialog with a fixture path.
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, fixture('latin.pdf'));

    await page.click('#btn-open');
    await waitForDocument(page);
    expect(await page.title()).toContain('latin.pdf');
    expect(await page.textContent('#page-total')).toBe('of 2');
  } finally {
    await app.close();
  }
});

test('a failed file picker leaves the app responsive and a retry opens normally', async () => {
  const { app, page } = await launchGloss();
  try {
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => { throw new Error('simulated desktop portal failure'); };
    });
    await page.click('#btn-open');
    await expect(page.locator('#toast')).toContainText('PDF picker failed');
    await expect(page.locator('#empty-state')).toBeVisible();
    expect(await page.getAttribute('body', 'data-ready')).toBe('1');

    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, fixture('latin.pdf'));
    await page.click('#btn-open');
    await waitForDocument(page);
    expect(await page.title()).toContain('latin.pdf');
  } finally {
    await app.close();
  }
});

test('an unexpected renderer rejection is contained and does not kill reading', async () => {
  const { app, page } = await launchGloss({ open: 'latin.pdf' });
  try {
    await waitForDocument(page);
    await page.evaluate(() => {
      setTimeout(() => Promise.reject(new Error('simulated non-fatal action failure')), 0);
    });
    await expect(page.locator('#toast')).toContainText('document is still open');
    await expect(page.locator('.pdf-page-wrapper[data-rendered="true"] canvas').first()).toBeVisible();
    expect(await page.getAttribute('body', 'data-ready')).toBe('1');

    // Normal controls continue to work after the rejected promise.
    await page.click('#btn-next-page');
    await expect(page.locator('#page-input')).toHaveValue('2');
  } finally {
    await app.close();
  }
});

test('a dictionary failure is explained while other reader controls stay usable', async () => {
  const { app, page } = await launchGloss({ open: 'latin.pdf' });
  try {
    await waitForDocument(page);
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('dict:lookup');
      ipcMain.handle('dict:lookup', () => [{
        dictName: 'My English MDX', dictKind: 'mdx', error: 'simulated worker timeout',
      }]);
    });
    await page.evaluate(async () => {
      const lookup = await import('./js/lookup.js');
      lookup.setPrefs({ wikipediaEnabled: false });
      await lookup.lookupSelection('serendipity', null);
    });

    await expect(page.locator('.popup-state--warning')).toContainText('My English MDX is unavailable');
    await expect(page.locator('.popup-state--warning')).toContainText('Reload it in Preferences');
    await page.click('#btn-next-page');
    await expect(page.locator('#page-input')).toHaveValue('2');
  } finally {
    await app.close();
  }
});

test('a crashed renderer reloads itself and reopens the current PDF', async () => {
  const { app, page } = await launchGloss({ open: 'latin.pdf' });
  try {
    await waitForDocument(page);
    await page.click('#btn-next-page');
    await expect(page.locator('#page-input')).toHaveValue('2');
    // Let the debounced reading-state save land before simulating the kind of
    // Chromium renderer failure a GPU/driver fault can cause.
    await page.waitForTimeout(800);

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer();
    });

    // Playwright deliberately marks the old CDP Page as permanently crashed;
    // Electron reloads the same BrowserWindow rather than emitting a new one.
    // Probe that live renderer through its main-process webContents instead.
    // Do not call executeJavaScript during Chromium's short transition from
    // the dead process: Electron 33 can leave that particular promise pending
    // even though the replacement finishes normally. Wait from the harness,
    // then query the recovered webContents once.
    await new Promise(resolve => setTimeout(resolve, 4000));
    const recovered = await app.evaluate(async ({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0]?.webContents;
      if (!wc || wc.isDestroyed() || wc.isCrashed()) return null;
      return wc.executeJavaScript(`({
        ready: document.body?.dataset.ready,
        title: document.title,
        page: document.getElementById('page-input')?.value,
        painted: !!document.querySelector('.pdf-page-wrapper[data-rendered="true"] canvas'),
        toast: document.getElementById('toast')?.textContent || ''
      })`);
    });
    expect(recovered).toMatchObject({
      ready: '1', title: 'latin.pdf — Gloss', page: '2', painted: true,
    });
    expect(recovered.toast).toContain('recovered its reading window');

    // The new renderer remains interactive, not merely painted.
    await app.evaluate(async ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
        `document.getElementById('btn-prev-page').click()`));
    await new Promise(resolve => setTimeout(resolve, 1000));
    const afterClick = await app.evaluate(async ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
        `document.getElementById('page-input').value`));
    expect(afterClick).toBe('1');
  } finally {
    await app.close();
  }
});

test('a corrupt saved glossary is reported after startup without blocking the reader', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-restore-failure-'));
  const broken = path.join(dataDir, 'broken.glossary.json');
  fs.writeFileSync(broken, '{ not JSON');
  fs.writeFileSync(path.join(dataDir, 'preferences.json'), JSON.stringify({
    dictionaries: { order: [broken], enabled: { [broken]: true } },
  }));

  const { app, page } = await launchGloss({ userDataDir: dataDir });
  try {
    await expect(page.locator('#toast')).toContainText('Could not restore', { timeout: 5000 });
    expect(await page.evaluate(() => window.gloss.listDictionaries())).toEqual([]);

    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, fixture('latin.pdf'));
    await page.click('#btn-open');
    await waitForDocument(page);
    expect(await page.title()).toContain('latin.pdf');
  } finally {
    await app.close();
  }
});

test('the drop overlay appears on drag, and a fabricated file is refused', async () => {
  const { app, page } = await launchGloss();
  try {
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([1])], 'x.pdf', { type: 'application/pdf' }));
      document.body.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
    });
    await expect(page.locator('#drop-overlay')).toBeVisible();

    // Dropping resolves the path in the preload via webUtils. A File
    // constructed inside the page has no backing path, so the open is
    // refused with a message instead of reading something arbitrary.
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([1])], 'x.pdf', { type: 'application/pdf' }));
      document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
    });
    await expect(page.locator('#drop-overlay')).toBeHidden();
    await expect(page.locator('#toast')).toBeVisible({ timeout: 5000 });
    expect(await page.locator('#empty-state').isVisible()).toBe(true);
  } finally {
    await app.close();
  }
});

test('recent documents are listed and reopen correctly', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-recents-'));

  const first = await launchGloss({ open: 'latin.pdf', userDataDir: dataDir });
  try {
    await waitForDocument(first.page);
    await first.page.waitForTimeout(700);
  } finally {
    await first.app.close();
  }

  const second = await launchGloss({ userDataDir: dataDir });
  try {
    await expect(second.page.locator('.recent-item')).toHaveCount(1);
    expect(await second.page.textContent('.recent-name')).toBe('latin.pdf');

    await second.page.click('.recent-item');
    await waitForDocument(second.page);
    expect(await second.page.title()).toContain('latin.pdf');
  } finally {
    await second.app.close();
  }
});

test('a recent entry whose file has vanished is shown as missing, not opened', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-missing-'));
  const docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-doc-'));
  const tempPdf = path.join(docDir, 'temporary.pdf');
  fs.copyFileSync(fixture('latin.pdf'), tempPdf);

  const first = await launchGloss({ userDataDir: dataDir, extraArgs: [tempPdf] });
  try {
    await waitForDocument(first.page);
    await first.page.waitForTimeout(700);
  } finally {
    await first.app.close();
  }

  fs.rmSync(tempPdf);

  const second = await launchGloss({ userDataDir: dataDir });
  try {
    const item = second.page.locator('.recent-item');
    await expect(item).toHaveCount(1);
    await expect(item).toBeDisabled();
    expect(await second.page.textContent('.recent-missing')).toBe('missing');
  } finally {
    await second.app.close();
  }
});

test('reduced motion disables animation and smooth scrolling', async () => {
  const { app, page } = await launchGloss({ open: 'large.pdf' });
  try {
    await waitForDocument(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });

    const duration = await page.evaluate(() => {
      const popup = document.getElementById('popup');
      popup.hidden = false;
      const d = getComputedStyle(popup).transitionDuration;
      popup.hidden = true;
      // Chromium formats the computed value of 0.01ms as "1e-05s".
      return parseFloat(d);
    });
    expect(duration).toBeLessThan(0.01);

    // CSS media queries do not affect scrollBy({behavior:'smooth'}), so the
    // app consults matchMedia as well.
    const behavior = await page.evaluate(async () => {
      const { scrollBehavior } = await import('./js/dom.js');
      return scrollBehavior();
    });
    expect(behavior).toBe('auto');
  } finally {
    await app.close();
  }
});

test('the interface is reachable and operable by keyboard alone', async () => {
  const { app, page } = await launchGloss({ open: 'latin.pdf' });
  try {
    await waitForDocument(page);

    const controls = await page.evaluate(() =>
      [...document.querySelectorAll('#toolbar button, #toolbar input, #toolbar select')]
        .map(el => ({
          id: el.id,
          labelled: !!(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent.trim()),
          focusable: el.tabIndex >= 0,
        })));
    expect(controls.length).toBeGreaterThan(5);
    expect(controls.filter(c => !c.labelled)).toEqual([]);
    expect(controls.filter(c => !c.focusable)).toEqual([]);

    // Preferences opens by keyboard, moves focus inside, closes with Escape.
    await page.keyboard.press('Control+Comma');
    await expect(page.locator('#prefs-overlay')).toBeVisible();
    expect(await page.evaluate(() =>
      document.getElementById('prefs-modal').contains(document.activeElement))).toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.locator('#prefs-overlay')).toBeHidden();

    // Keyboard focus is visibly indicated. :focus-visible is a pseudo-class,
    // so it has to be observed on the real focused element, not requested
    // from getComputedStyle as if it were a pseudo-element.
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
      const el = document.activeElement;
      const cs = getComputedStyle(el);
      return {
        matchesFocusVisible: el.matches(':focus-visible'),
        outlineWidth: parseFloat(cs.outlineWidth),
        outlineStyle: cs.outlineStyle,
      };
    });
    expect(focus.matchesFocusVisible).toBe(true);
    expect(focus.outlineWidth).toBeGreaterThanOrEqual(2);
    expect(focus.outlineStyle).not.toBe('none');

    // A live region exists for announcements.
    expect(await page.getAttribute('#sr-status', 'aria-live')).toBe('polite');
  } finally {
    await app.close();
  }
});

test('a real encrypted PDF handles wrong, correct, and cancelled passwords', async () => {
  test.skip(!fs.existsSync(path.join(FIXTURES, 'encrypted.pdf')),
    'Run npm run fixtures with Ghostscript installed to build encrypted.pdf');
  const { app, page } = await launchGloss();
  try {
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, fixture('encrypted.pdf'));
    await page.click('#btn-open');
    await expect(page.locator('#password-overlay')).toBeVisible();
    await expect(page.locator('#password-input')).toBeFocused();

    await page.fill('#password-input', 'wrong password');
    await page.click('#password-form button[type="submit"]');
    await expect(page.locator('#password-error')).toBeVisible();
    await expect(page.locator('#password-input')).toBeFocused();

    await page.fill('#password-input', 'gloss');
    await page.click('#password-form button[type="submit"]');
    await waitForDocument(page);
    await expect(page.locator('#password-overlay')).toBeHidden();
    expect(await page.title()).toContain('encrypted.pdf');

    // Cancelling a later open attempt leaves the already displayed document
    // and its canvas untouched.
    const canvasCount = await page.locator('.pdf-page-wrapper canvas').count();
    await page.click('#btn-open');
    await expect(page.locator('#password-overlay')).toBeVisible();
    await page.click('#password-cancel');
    await expect(page.locator('#password-overlay')).toBeHidden();
    expect(await page.title()).toContain('encrypted.pdf');
    expect(await page.locator('.pdf-page-wrapper canvas').count()).toBe(canvasCount);
  } finally {
    await app.close();
  }
});
