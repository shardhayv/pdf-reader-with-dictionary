'use strict';
/**
 * Persistent state: preferences + per-document reading state.
 *
 * Files live in app.getPath('userData') (XDG config on Linux):
 *   preferences.json — app-wide settings, window state, dictionary list
 *   documents.json   — per-document reading state; recents derive from it
 *
 * These files sit inside the user's own trust boundary; validation here is
 * defensive (types, enums, clamps), not a security boundary. Writes are
 * debounced and atomic (tmp + rename); a synchronous flush runs on quit.
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const SAVE_DEBOUNCE_MS = 500;
const MAX_TRACKED_DOCUMENTS = 60;
const MAX_RECENTS = 10;

const THEMES = new Set(['system', 'light', 'dark']);
const PAGE_TONES = new Set(['original', 'warm', 'sepia', 'dark']);
const WIKI_LANGS = new Set(['en', 'hi', 'ne', 'mai']);
const ZOOM_MODES = new Set(['fit-width', 'fit-page', 'custom']);
const SIDEBAR_TABS = new Set(['thumbnails', 'outline', 'bookmarks']);
const ROTATIONS = new Set([0, 90, 180, 270]);
const SPREAD_MODES = new Set(['single', 'two-page']);
const MAX_SAVED_WORDS = 500;
const MAX_BOOKMARKS = 200;

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;

const PREF_DEFAULTS = Object.freeze({
  theme: 'system',
  pageTone: 'original',
  wiktionaryEnabled: true,
  wiktionaryAsFallback: true,
  wikipediaEnabled: true,
  wikipediaAsFallback: true,
  wikipediaLang: 'en',
  webSearchLinkEnabled: true,
  sidebarVisible: false,
  sidebarTab: 'thumbnails',
  savedWords: [],
  window: { bounds: null, isMaximized: false },
  dictionaries: { order: [], enabled: {}, bundledSeen: [] },
});

/** Keys the renderer may write through prefs:set. */
const RENDERER_WRITABLE = new Set([
  'theme', 'pageTone', 'wikipediaEnabled', 'wikipediaAsFallback', 'wikipediaLang',
  'wiktionaryEnabled', 'wiktionaryAsFallback', 'webSearchLinkEnabled',
  'sidebarVisible', 'sidebarTab', 'savedWords',
]);

let prefs = structuredClone(PREF_DEFAULTS);
let docs = {}; // realpath -> sanitizeDocState() record (position, zoom, rotation, bookmarks…)

let prefsTimer = null;
let docsTimer = null;
let loadWarnings = [];
let errorHandler = null;

function prefsPath() { return path.join(app.getPath('userData'), 'preferences.json'); }
function docsPath() { return path.join(app.getPath('userData'), 'documents.json'); }

// ── Validation ────────────────────────────────────────────────────────────────

function asBool(v, fallback) { return typeof v === 'boolean' ? v : fallback; }
function asEnum(v, set, fallback) { return set.has(v) ? v : fallback; }
function clampNum(v, min, max, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

function sanitizePrefs(raw) {
  const d = PREF_DEFAULTS;
  const src = raw && typeof raw === 'object' ? raw : {};
  const w = src.window && typeof src.window === 'object' ? src.window : {};
  const b = w.bounds;
  const boundsOk = b && typeof b === 'object' &&
    [b.x, b.y, b.width, b.height].every(n => typeof n === 'number' && Number.isFinite(n)) &&
    b.width >= 400 && b.height >= 300 && b.width <= 20000 && b.height <= 20000;
  const dicts = src.dictionaries && typeof src.dictionaries === 'object' ? src.dictionaries : {};
  const order = Array.isArray(dicts.order)
    ? dicts.order.filter(p => typeof p === 'string' && p.length < 4096).slice(0, 50)
    : [];
  const enabled = {};
  if (dicts.enabled && typeof dicts.enabled === 'object') {
    for (const p of order) enabled[p] = dicts.enabled[p] !== false;
  }
  // File names of packaged dictionaries this profile has already been offered
  // (see dicts.restoreFromPrefs): the record that keeps a removed dictionary
  // removed.
  const bundledSeen = Array.isArray(dicts.bundledSeen)
    ? [...new Set(dicts.bundledSeen.filter(n => typeof n === 'string' && n.length > 0 && n.length < 256))].slice(0, 200)
    : [];
  const savedWords = Array.isArray(src.savedWords)
    ? src.savedWords
      .filter(item => item && typeof item === 'object' && typeof item.word === 'string' && item.word.trim().length > 0)
      .slice(0, MAX_SAVED_WORDS)
      .map(item => ({
        word: item.word.trim().slice(0, 120),
        definition: typeof item.definition === 'string' ? item.definition.trim().slice(0, 1200) : '',
        source: typeof item.source === 'string' ? item.source.trim().slice(0, 120) : '',
        docName: typeof item.docName === 'string' ? item.docName.trim().slice(0, 200) : '',
        page: Number.isInteger(item.page) && item.page > 0 ? item.page : null,
        savedAt: clampNum(item.savedAt, 0, 8.64e15, Date.now()),
      }))
    : [];
  return {
    theme: asEnum(src.theme, THEMES, d.theme),
    pageTone: asEnum(src.pageTone, PAGE_TONES, d.pageTone),
    wiktionaryEnabled: asBool(src.wiktionaryEnabled, d.wiktionaryEnabled),
    wiktionaryAsFallback: asBool(src.wiktionaryAsFallback, d.wiktionaryAsFallback),
    wikipediaEnabled: asBool(src.wikipediaEnabled, d.wikipediaEnabled),
    wikipediaAsFallback: asBool(src.wikipediaAsFallback, d.wikipediaAsFallback),
    wikipediaLang: asEnum(src.wikipediaLang, WIKI_LANGS, d.wikipediaLang),
    webSearchLinkEnabled: asBool(src.webSearchLinkEnabled, d.webSearchLinkEnabled),
    sidebarVisible: asBool(src.sidebarVisible, d.sidebarVisible),
    sidebarTab: asEnum(src.sidebarTab, SIDEBAR_TABS, d.sidebarTab),
    savedWords,
    window: {
      bounds: boundsOk ? { x: b.x, y: b.y, width: b.width, height: b.height } : null,
      isMaximized: asBool(w.isMaximized, false),
    },
    dictionaries: { order, enabled, bundledSeen },
  };
}

function sanitizeDocState(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const bookmarks = Array.isArray(src.bookmarks)
    ? [...new Set(src.bookmarks.filter(n => Number.isInteger(n) && n >= 1 && n <= 1e6))]
      .sort((a, b) => a - b)
      .slice(0, MAX_BOOKMARKS)
    : [];
  return {
    name: typeof src.name === 'string' ? src.name.slice(0, 300) : '',
    page: Math.max(1, Math.round(clampNum(src.page, 1, 1e6, 1))),
    zoomMode: asEnum(src.zoomMode, ZOOM_MODES, 'fit-width'),
    zoomScale: clampNum(src.zoomScale, ZOOM_MIN, ZOOM_MAX, 1),
    scrollFraction: clampNum(src.scrollFraction, 0, 1, 0),
    // Exact reading position: the page at the top of the viewport and how far
    // down it, as a fraction of that page's height. Unlike scrollFraction this
    // survives the window being a different size next time. 0 = not recorded.
    topPage: Number.isInteger(src.topPage) && src.topPage >= 1 ? Math.min(src.topPage, 1e6) : 0,
    topOffset: clampNum(src.topOffset, -0.5, 1, 0),
    rotation: ROTATIONS.has(src.rotation) ? src.rotation : 0,
    spreadMode: asEnum(src.spreadMode, SPREAD_MODES, 'single'),
    bookmarks,
    lastOpened: clampNum(src.lastOpened, 0, 8.64e15, Date.now()),
  };
}

// ── Load / save ───────────────────────────────────────────────────────────────

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null; // normal first run
    let backup = '';
    try {
      backup = `${file}.corrupt-${Date.now()}`;
      fs.copyFileSync(file, backup);
    } catch {
      backup = '';
    }
    const message = `${label} could not be read; Gloss is using safe defaults.`;
    loadWarnings.push({ message, backup });
    console.error(`gloss: ${message}`, error?.message || error, backup ? `(backup: ${backup})` : '');
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('gloss: state save failed:', err.message);
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* preserve original; cleanup is best effort */ }
    try {
      errorHandler?.({
        message: 'Gloss could not save preferences or reading position. Check available disk space and folder permissions.',
      });
    } catch (handlerError) {
      console.error('gloss: state-error notification failed:', handlerError?.message || handlerError);
    }
  }
}

function load() {
  loadWarnings = [];
  prefs = sanitizePrefs(readJson(prefsPath(), 'Preferences'));
  const rawDocs = readJson(docsPath(), 'Reading history');
  docs = {};
  if (rawDocs && typeof rawDocs.docs === 'object' && rawDocs.docs !== null) {
    for (const [p, state] of Object.entries(rawDocs.docs)) {
      if (typeof p === 'string' && p.length < 4096) docs[p] = sanitizeDocState(state);
    }
  }
  pruneDocs();
}

function consumeLoadWarnings() {
  const warnings = loadWarnings.map(item => ({ ...item }));
  loadWarnings = [];
  return warnings;
}

function setErrorHandler(handler) {
  errorHandler = typeof handler === 'function' ? handler : null;
}

function schedulePrefsSave() {
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => writeJsonAtomic(prefsPath(), prefs), SAVE_DEBOUNCE_MS);
}

function scheduleDocsSave() {
  clearTimeout(docsTimer);
  docsTimer = setTimeout(() => writeJsonAtomic(docsPath(), { docs }), SAVE_DEBOUNCE_MS);
}

function flushSync() {
  clearTimeout(prefsTimer);
  clearTimeout(docsTimer);
  writeJsonAtomic(prefsPath(), prefs);
  writeJsonAtomic(docsPath(), { docs });
}

function pruneDocs() {
  const entries = Object.entries(docs);
  if (entries.length <= MAX_TRACKED_DOCUMENTS) return;
  entries.sort((a, b) => b[1].lastOpened - a[1].lastOpened);
  docs = Object.fromEntries(entries.slice(0, MAX_TRACKED_DOCUMENTS));
}

// ── Public API ────────────────────────────────────────────────────────────────

function getPrefs() {
  return structuredClone(prefs);
}

/** Renderer-facing write: only allowlisted keys, values re-validated. */
function setPrefsFromRenderer(delta) {
  if (!delta || typeof delta !== 'object') return getPrefs();
  const merged = { ...prefs };
  for (const key of Object.keys(delta)) {
    if (RENDERER_WRITABLE.has(key)) merged[key] = delta[key];
  }
  prefs = sanitizePrefs(merged);
  schedulePrefsSave();
  return getPrefs();
}

/** Main-internal write (window state, dictionary list). */
function setPrefsInternal(mutator) {
  mutator(prefs);
  prefs = sanitizePrefs(prefs);
  schedulePrefsSave();
}

function getDocState(realPath) {
  return docs[realPath] ? structuredClone(docs[realPath]) : null;
}

function updateDocState(realPath, patch) {
  const current = docs[realPath] || {};
  docs[realPath] = sanitizeDocState({ ...current, ...patch, lastOpened: Date.now() });
  pruneDocs();
  scheduleDocsSave();
}

function recents() {
  return Object.entries(docs)
    .sort((a, b) => b[1].lastOpened - a[1].lastOpened)
    .slice(0, MAX_RECENTS)
    .map(([p, state]) => ({
      path: p,
      name: state.name || path.basename(p),
      lastOpened: state.lastOpened,
      exists: fs.existsSync(p),
    }));
}

function clearRecents() {
  docs = {};
  scheduleDocsSave();
}

module.exports = {
  ZOOM_MIN, ZOOM_MAX,
  load, flushSync,
  consumeLoadWarnings, setErrorHandler,
  getPrefs, setPrefsFromRenderer, setPrefsInternal,
  getDocState, updateDocState,
  recents, clearRecents,
};
