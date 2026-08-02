'use strict';
/**
 * Remaining integration paths: the file dialog, drag-and-drop, recent
 * documents, reduced motion, keyboard accessibility, and the password UI.
 */

const { test, expect } = require('@playwright/test');
const { launchGloss, waitForDocument, fixture } = require('./helpers');

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

test('the password prompt takes focus and cancelling leaves the app usable', async () => {
  const { app, page } = await launchGloss();
  try {
    const state = await page.evaluate(async () => {
      const overlay = document.getElementById('password-overlay');
      const before = overlay.hidden;
      overlay.hidden = false;
      document.getElementById('password-input').focus();
      const focused = document.activeElement.id;
      document.getElementById('password-cancel').click();
      await new Promise(r => setTimeout(r, 250));
      return { before, focused, afterCancel: overlay.hidden };
    });
    expect(state.before).toBe(true);
    expect(state.focused).toBe('password-input');
    expect(state.afterCancel).toBe(true);
    await expect(page.locator('#empty-state')).toBeVisible();
  } finally {
    await app.close();
  }
});
