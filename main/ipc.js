'use strict';
/**
 * The complete IPC surface. Every handler:
 *   1. validates the sender synchronously (security.guarded),
 *   2. validates argument shapes,
 *   3. keeps path authority in the main process (see paths.js).
 */

const { ipcMain, dialog, shell } = require('electron');
const paths = require('./paths');
const store = require('./store');
const dicts = require('./dicts');
const wiki = require('./wiki');
const wiktionary = require('./wiktionary');
const windows = require('./windows');
const { guarded } = require('./security');

/** webContents.id -> { path, fingerprint } for the displayed document. */
const currentDocByContents = new Map();

/**
 * webContents.id -> a document that was read successfully but not yet
 * confirmed as opened by the renderer. A file only enters the recent list
 * once it actually opens, so a damaged PDF never pollutes it.
 */
const pendingDocByContents = new Map();
const trackedContents = new Set();

const MAX_URL_LENGTH = 2048;

/**
 * Called when the renderer has finished wiring its listeners. Sending a
 * queued document before this point loses it: did-finish-load fires while
 * the renderer's async boot is still running.
 */
let readyHandler = null;
function setReadyHandler(fn) { readyHandler = fn; }

function assertString(value, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Error('gloss: invalid argument');
  }
  return value;
}

/**
 * Shared open pipeline (dialog, drop, recents, CLI, second instance): read
 * safely and hand the bytes over. Nothing is committed to persistent state
 * here — the renderer has to parse the file first (see doc:confirmOpen).
 */
async function openAndTrack(webContents, requestedPath) {
  const result = await paths.readPdfSafely(requestedPath);
  if (!result.ok) return result;
  if (webContents.isDestroyed()) {
    return { ok: false, code: 'window_closed', message: 'The Gloss window was closed before the PDF finished opening.' };
  }

  trackContentsLifetime(webContents);
  pendingDocByContents.set(webContents.id, { realPath: result.realPath, name: result.name });

  return {
    ok: true,
    path: result.realPath,
    name: result.name,
    size: result.size,
    data: result.data, // Buffer -> Uint8Array across the bridge
    state: store.getDocState(result.realPath),
  };
}

function trackContentsLifetime(webContents) {
  if (trackedContents.has(webContents.id)) return;
  trackedContents.add(webContents.id);
  webContents.once('destroyed', () => {
    trackedContents.delete(webContents.id);
    pendingDocByContents.delete(webContents.id);
    currentDocByContents.delete(webContents.id);
  });
}

/** Main-initiated open (CLI arg, second instance, file association). */
async function openFromMain(requestedPath) {
  const win = windows.getMainWindow();
  if (!win) return;
  let payload;
  try {
    payload = await openAndTrack(win.webContents, requestedPath);
  } catch (err) {
    console.error('gloss: main-initiated open failed:', err);
    payload = {
      ok: false,
      code: 'open_failed',
      message: 'Gloss could not read that PDF. The document already open was not changed.',
    };
  }
  if (win.isDestroyed() || win.webContents.isDestroyed()) return;
  try {
    win.webContents.send('gloss:open-file', payload);
  } catch (error) {
    console.error('gloss: could not deliver an opened PDF to the window:', error?.message || error);
  }
}

/** Last confirmed document for a window, used only to recover a crashed renderer. */
function currentDocumentPath(webContents) {
  if (!webContents || webContents.isDestroyed()) return null;
  return currentDocByContents.get(webContents.id)?.path || null;
}

function register() {
  ipcMain.handle('app:ready', guarded(() => {
    readyHandler?.();
    return { ok: true };
  }));

  // ── PDF opening ────────────────────────────────────────────────────────────
  ipcMain.handle('pdf:openDialog', guarded(async (event) => {
    const win = windows.getMainWindow();
    const r = await dialog.showOpenDialog(win, {
      title: 'Open PDF',
      filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
      properties: ['openFile'],
    });
    if (r.canceled || r.filePaths.length === 0) return { ok: false, code: 'canceled', message: '' };
    return openAndTrack(event.sender, r.filePaths[0]);
  }));

  // Path arrives from the isolated preload, which resolved it from a real
  // dropped File via webUtils.getPathForFile — the page cannot fabricate it.
  ipcMain.handle('pdf:openDropped', guarded(async (event, droppedPath) => {
    assertString(droppedPath, 4096);
    if (!paths.looksLikePdfName(droppedPath)) {
      return { ok: false, code: 'not_pdf', message: 'Only PDF files can be opened.' };
    }
    return openAndTrack(event.sender, droppedPath);
  }));

  ipcMain.handle('pdf:openRecent', guarded(async (event, recentPath) => {
    assertString(recentPath, 4096);
    const known = store.recents().some(r => r.path === recentPath);
    if (!known) return { ok: false, code: 'not_recent', message: 'That file is not in the recent list.' };
    return openAndTrack(event.sender, recentPath);
  }));

  // ── Per-document state ─────────────────────────────────────────────────────
  // Called once the renderer has parsed and displayed the document. Only now
  // does it become the current document and enter the recent list.
  ipcMain.handle('doc:confirmOpen', guarded((event, docPath, fingerprint = '') => {
    assertString(docPath, 4096);
    if (typeof fingerprint !== 'string' || fingerprint.length > 200) fingerprint = '';
    const pending = pendingDocByContents.get(event.sender.id);
    if (!pending || pending.realPath !== docPath) return { ok: false };
    pendingDocByContents.delete(event.sender.id);
    trackContentsLifetime(event.sender);
    currentDocByContents.set(event.sender.id, { path: pending.realPath, fingerprint });
    store.updateDocState(pending.realPath, { name: pending.name });
    windows.buildMenu(); // refresh Open Recent
    return { ok: true };
  }));

  ipcMain.handle('doc:updateState', guarded((event, docPath, patch) => {
    assertString(docPath, 4096);
    if (currentDocByContents.get(event.sender.id)?.path !== docPath) return { ok: false };
    if (!patch || typeof patch !== 'object') return { ok: false };
    const {
      page, zoomMode, zoomScale, scrollFraction, topPage, topOffset, rotation, spreadMode, bookmarks,
    } = patch;
    const delta = { page, zoomMode, zoomScale, scrollFraction, topPage, topOffset, rotation, spreadMode };
    if (Array.isArray(bookmarks)) delta.bookmarks = bookmarks;
    store.updateDocState(docPath, delta);
    return { ok: true };
  }));

  ipcMain.handle('recents:get', guarded(() => store.recents()));
  ipcMain.handle('recents:clear', guarded(() => {
    store.clearRecents();
    windows.buildMenu();
    return { ok: true };
  }));

  // ── Dictionaries ───────────────────────────────────────────────────────────
  ipcMain.handle('dict:addViaDialog', guarded(async () => {
    const win = windows.getMainWindow();
    const r = await dialog.showOpenDialog(win, {
      title: 'Add dictionaries and glossaries',
      filters: [
        { name: 'Dictionaries and glossaries', extensions: ['mdx', 'json'] },
        { name: 'MDict dictionaries', extensions: ['mdx'] },
        { name: 'Gloss glossaries', extensions: ['json'] },
      ],
      properties: ['openFile', 'multiSelections'],
    });
    if (r.canceled || r.filePaths.length === 0) return [];
    return dicts.loadMany(r.filePaths);
  }));

  ipcMain.handle('dict:list', guarded((event) => dicts.list(currentDocByContents.get(event.sender.id))));
  ipcMain.handle('dict:reload', guarded((_e, p) => dicts.reload(assertString(p, 4096))));
  ipcMain.handle('dict:remove', guarded((_e, p) => dicts.remove(assertString(p, 4096))));
  ipcMain.handle('dict:toggle', guarded((_e, p) => dicts.toggle(assertString(p, 4096))));
  ipcMain.handle('dict:reorder', guarded((_e, order) => dicts.reorder(order)));
  ipcMain.handle('dict:lookup', guarded((event, candidates) =>
    dicts.lookup(candidates, currentDocByContents.get(event.sender.id))));

  // ── Online sources ─────────────────────────────────────────────────────────
  ipcMain.handle('wiki:lookup', guarded((_e, lang, title) => wiki.lookup(lang, title)));
  ipcMain.handle('wiktionary:lookup', guarded((_e, lang, word) => wiktionary.lookup(lang, word)));

  // ── Preferences ────────────────────────────────────────────────────────────
  ipcMain.handle('prefs:get', guarded(() => store.getPrefs()));
  ipcMain.handle('prefs:set', guarded((_e, delta) => {
    const updated = store.setPrefsFromRenderer(delta);
    windows.applyThemeSource();
    return updated;
  }));

  // ── Shell / window ─────────────────────────────────────────────────────────
  ipcMain.handle('shell:openExternal', guarded(async (_e, url) => {
    assertString(url, MAX_URL_LENGTH);
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false };
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { ok: false };
    try {
      await shell.openExternal(parsed.toString());
      return { ok: true };
    } catch (error) {
      console.error('gloss: external link failed:', error?.message || error);
      return { ok: false, message: 'The system could not open that link.' };
    }
  }));

  ipcMain.handle('window:setReadMode', guarded((_e, on) => {
    windows.setReadMode(!!on);
    return { ok: true };
  }));
}

module.exports = { register, openFromMain, setReadyHandler, currentDocumentPath };
