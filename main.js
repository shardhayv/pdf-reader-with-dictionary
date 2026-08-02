'use strict';
/**
 * Gloss — main process entry.
 * Single instance; PDFs arrive via dialog, drag-and-drop, CLI arguments,
 * file association, or a second launch (which focuses this instance).
 */

const { app } = require('electron');
const paths = require('./main/paths');
const store = require('./main/store');
const security = require('./main/security');
const windows = require('./main/windows');
const ipc = require('./main/ipc');
const dicts = require('./main/dicts');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let rendererReady = false;
  let pendingOpen = paths.extractPdfArgs(process.argv, process.cwd())[0] || null;

  security.installAppHardening(app);

  app.on('second-instance', (_event, argv, workingDirectory) => {
    const win = windows.getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    const requested = paths.extractPdfArgs(argv, workingDirectory)[0];
    if (!requested) return;
    if (rendererReady) ipc.openFromMain(requested);
    else pendingOpen = requested;
  });

  app.whenReady().then(() => {
    store.load();
    windows.applyThemeSource();
    ipc.register();

    ipc.setReadyHandler(() => {
      rendererReady = true;
      if (pendingOpen) {
        const p = pendingOpen;
        pendingOpen = null;
        ipc.openFromMain(p);
      }
    });

    const win = windows.createMainWindow();
    security.hardenSession(win.webContents.session);
    windows.buildMenu();

    // Restore saved dictionaries after first paint — MDX parsing is
    // synchronous and must not delay the window.
    win.once('ready-to-show', () => {
      setTimeout(() => dicts.restoreFromPrefs(), 80);
    });

    app.on('activate', () => {
      if (!windows.getMainWindow()) {
        const w = windows.createMainWindow();
        security.hardenSession(w.webContents.session);
      }
    });
  });

  app.on('will-quit', () => store.flushSync());
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
