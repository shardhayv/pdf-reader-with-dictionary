'use strict';
/**
 * Preload bridge — the renderer's entire capability surface (window.gloss).
 * Runs sandboxed with context isolation; only contextBridge/ipcRenderer/
 * webUtils are used. Paths never originate from page-controlled strings:
 * dropped files are resolved here via webUtils.getPathForFile, so a
 * compromised page cannot name arbitrary filesystem paths.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function on(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('gloss', {
  // Signals that the renderer has wired its listeners and can receive a
  // document queued from a CLI argument or file association.
  notifyReady: () => ipcRenderer.invoke('app:ready'),

  // PDF opening
  openPdfDialog: () => ipcRenderer.invoke('pdf:openDialog'),
  openDroppedPdf: (file) => {
    let filePath = '';
    try { filePath = webUtils.getPathForFile(file); } catch { /* not a real file */ }
    if (!filePath) return Promise.resolve({ ok: false, code: 'not_file', message: 'Not an openable file.' });
    return ipcRenderer.invoke('pdf:openDropped', filePath);
  },
  openRecent: (path) => ipcRenderer.invoke('pdf:openRecent', path),
  onOpenFile: (cb) => on('gloss:open-file', cb),

  // Commands pushed from the application menu / main process
  onCommand: (cb) => on('gloss:cmd', cb),

  // Per-document reading state
  confirmOpen: (path, fingerprint) => ipcRenderer.invoke('doc:confirmOpen', path, fingerprint),
  updateDocState: (path, patch) => ipcRenderer.invoke('doc:updateState', path, patch),
  getRecents: () => ipcRenderer.invoke('recents:get'),
  clearRecents: () => ipcRenderer.invoke('recents:clear'),

  // Dictionaries
  addDictionaries: () => ipcRenderer.invoke('dict:addViaDialog'),
  listDictionaries: () => ipcRenderer.invoke('dict:list'),
  reloadDictionary: (path) => ipcRenderer.invoke('dict:reload', path),
  removeDictionary: (path) => ipcRenderer.invoke('dict:remove', path),
  toggleDictionary: (path) => ipcRenderer.invoke('dict:toggle', path),
  reorderDictionaries: (order) => ipcRenderer.invoke('dict:reorder', order),
  lookupDictionaries: (candidates) => ipcRenderer.invoke('dict:lookup', candidates),
  onDictionariesChanged: (cb) => on('gloss:dictionaries-changed', cb),
  onStorageError: (cb) => on('gloss:storage-error', cb),

  // Online sources (network lives in main)
  lookupWikipedia: (lang, title) => ipcRenderer.invoke('wiki:lookup', lang, title),
  lookupWiktionary: (lang, word) => ipcRenderer.invoke('wiktionary:lookup', lang, word),

  // Preferences
  getPrefs: () => ipcRenderer.invoke('prefs:get'),
  setPrefs: (delta) => ipcRenderer.invoke('prefs:set', delta),

  // Shell / window
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  setReadMode: (on_) => ipcRenderer.invoke('window:setReadMode', on_),
});
