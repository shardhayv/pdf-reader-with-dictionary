'use strict';
/**
 * Gloss — main process entry.
 * Single instance; PDFs arrive via dialog, drag-and-drop, CLI arguments,
 * file association, or a second launch (which focuses this instance).
 */

const { app, dialog } = require('electron');
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
  let rendererGeneration = 0;
  let pendingOpen = paths.extractPdfArgs(process.argv, process.cwd())[0] || null;
  let quitting = false;

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
    const pendingNotices = store.consumeLoadWarnings();
    windows.applyThemeSource();
    ipc.register();

    ipc.setReadyHandler(() => {
      rendererReady = true;
      const generation = ++rendererGeneration;
      if (pendingOpen) {
        const p = pendingOpen;
        pendingOpen = null;
        ipc.openFromMain(p);
      }

      // Restore after the renderer is listening, then explicitly tell it to
      // refresh. Restoring after first paint keeps a large MDX from delaying
      // the window; the event prevents the toolbar from incorrectly saying
      // "No local dictionaries" until Preferences is opened.
      setTimeout(async () => {
        let failed = [];
        try {
          failed = (await dicts.restoreFromPrefs()).filter(result => !result.success);
          if (failed.length > 0) console.warn('gloss: some dictionaries could not be restored:', failed);
        } catch (err) {
          // The reader remains fully usable without dictionaries.
          console.error('gloss: dictionary restore failed:', err);
          failed = [{ name: 'Saved dictionaries', error: 'Unexpected restore error' }];
        }
        // A previous renderer's delayed restore may finish after Chromium has
        // already recovered into a new one. It must not consume notices or
        // send stale state to that new interface.
        if (!rendererReady || generation !== rendererGeneration) return;
        // Consume notices only when they are about to reach a live renderer.
        // Old corrupt-state warnings therefore are not repeated on reload,
        // while a crash-recovery notice cannot be lost to the dead instance.
        const warnings = pendingNotices.splice(0);
        const current = windows.getMainWindow();
        if (current && !current.isDestroyed()) {
          try {
            current.webContents.send('gloss:dictionaries-changed', {
              failed: failed.map(item => ({ name: item.name || 'Dictionary', error: item.error || 'Could not load' })),
              warnings,
            });
          } catch { /* the window closed while a dictionary worker was loading */ }
        }
      }, 80);
    });

    const win = windows.createMainWindow();
    security.hardenSession(win.webContents.session);

    // Chromium renderer processes can be killed by a GPU/driver fault or an
    // out-of-memory condition without taking Electron's main process down.
    // Recover the interface automatically and reopen the confirmed PDF at its
    // saved position. Repeated crashes are not looped forever: the reader gets
    // an explicit Reload/Quit choice on the third failure in one minute.
    const rendererFailures = [];
    win.webContents.on('render-process-gone', (_event, details) => {
      if (quitting || details?.reason === 'clean-exit' || win.isDestroyed()) return;
      console.error('gloss: renderer process stopped:', details?.reason || 'unknown');
      rendererReady = false;
      const activePath = ipc.currentDocumentPath(win.webContents);
      if (activePath) pendingOpen = activePath;
      pendingNotices.push({
        message: 'Gloss recovered its reading window after an unexpected renderer failure. Your PDF was not changed.',
      });

      const now = Date.now();
      rendererFailures.push(now);
      while (rendererFailures.length && rendererFailures[0] < now - 60_000) rendererFailures.shift();

      const reload = () => {
        if (quitting || win.isDestroyed() || win.webContents.isDestroyed()) return;
        try { win.webContents.reload(); } catch (error) {
          console.error('gloss: renderer reload failed:', error);
          dialog.showErrorBox('Gloss needs to restart',
            'The reading window could not be recovered. Your PDF and saved reading state were not changed.');
          app.quit();
        }
      };

      if (rendererFailures.length <= 2) {
        setTimeout(reload, 120);
        return;
      }
      dialog.showMessageBox(win, {
        type: 'warning',
        title: 'Gloss reading window stopped',
        message: 'The reading window stopped repeatedly.',
        detail: 'Your PDF and saved reading position were not changed. You can try loading the window again or quit Gloss.',
        buttons: ['Reload', 'Quit'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      }).then(({ response }) => {
        if (response === 0) reload(); else app.quit();
      }).catch(error => {
        console.error('gloss: renderer recovery dialog failed:', error);
        reload();
      });
    });
    store.setErrorHandler((notice) => {
      const current = windows.getMainWindow();
      if (current && !current.isDestroyed() && !current.webContents.isDestroyed()) {
        try { current.webContents.send('gloss:storage-error', notice); } catch { /* window closed during save */ }
      }
    });
    windows.buildMenu();

    app.on('activate', () => {
      if (!windows.getMainWindow()) {
        const w = windows.createMainWindow();
        security.hardenSession(w.webContents.session);
      }
    });
  }).catch(err => {
    console.error('gloss: startup failed:', err);
    dialog.showErrorBox(
      'Gloss could not start',
      'Gloss encountered an unexpected startup error. Your PDFs, dictionaries, and reading state were not changed.'
    );
    app.quit();
  });

  app.on('will-quit', () => {
    quitting = true;
    dicts.closeAll();
    store.flushSync();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
