'use strict';
/**
 * Dictionary registry (main process).
 *
 * Two backends sit behind one interface: MDX files you download, and JSON
 * glossaries you build (see main/glossary.js — typically one per book).
 * They share the priority list, the enable/disable toggles, and the lookup
 * ladder, so the rest of the app never needs to know which is which.
 *
 * All dictionary content is treated as hostile: definitions returned from
 * here are raw untrusted HTML/text and MUST be sanitized in the renderer
 * before insertion (see renderer/js/popup.js).
 *
 * Lookup contract: the renderer sends an ordered candidate ladder
 * (exact → NFC → trimmed → script variants → case variants, built by
 * renderer/js/text.js). For each enabled dictionary in priority order we
 * return the first candidate that hits, so exact/proper-case entries
 * (Paris, NASA, precomposed nukta forms) always win over folded forms.
 */

const fs = require('fs');
const path = require('path');
let app;
try { ({ app } = require('electron')); } catch { app = null; }
const store = require('./store');
const { Glossary, isGlossaryPath } = require('./glossary');

const MAX_CANDIDATES = 10;
const MAX_CANDIDATE_LENGTH = 120;
const MAX_DEFINITION_BYTES = 512 * 1024;

/** realpath -> { name, kind, source, enabled } */
const dictionaries = new Map();

let MDX = null;
function getMDX() {
  if (!MDX) ({ MDX } = require('js-mdict'));
  return MDX;
}

/** Open a file with the backend its extension calls for. */
async function openBackend(realPath) {
  if (isGlossaryPath(realPath)) {
    const glossary = new Glossary(realPath);
    return { kind: 'glossary', source: glossary, title: glossary.title };
  }
  // Unit tests can opt into the old synchronous fake backend. The app always
  // parses real MDX files in a worker so a large dictionary cannot freeze the
  // window or PDF scrolling.
  if (process.env.GLOSS_SYNC_MDX === '1') {
    return { kind: 'mdx', source: new (getMDX())(realPath), title: '' };
  }
  const { MdxWorkerClient } = require('./mdx-worker-client');
  return { kind: 'mdx', source: await MdxWorkerClient.open(realPath), title: '' };
}

function metadata(dict, document = null) {
  const glossary = dict.kind === 'glossary' ? dict.source : null;
  const applicable = glossary ? glossary.matchesDocument(document) : true;
  return {
    kind: dict.kind,
    scope: glossary?.scope || 'global',
    sourceFile: glossary?.sourceFile || '',
    entryCount: glossary?.size ?? null,
    draftCount: glossary ? Math.max(0, glossary.totalEntries - glossary.size) : null,
    applicable,
    active: dict.enabled && applicable,
    error: dict.error || '',
  };
}

function persist() {
  store.setPrefsInternal(prefs => {
    prefs.dictionaries.order = [...dictionaries.keys()];
    prefs.dictionaries.enabled = {};
    for (const [p, d] of dictionaries) prefs.dictionaries.enabled[p] = d.enabled;
  });
}

function displayName(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

function loadError(error, realPath) {
  const raw = error && error.message ? String(error.message).slice(0, 200) : '';
  if (isGlossaryPath(realPath)) return raw || 'Unreadable JSON glossary';
  if (/took too long/i.test(raw)) return 'This MDX dictionary took too long to load. Try Reload; if it repeats, use a smaller dictionary.';
  if (/worker.*(?:stopped|closed)|not running/i.test(raw)) {
    return 'The MDX reader stopped unexpectedly. Reload the dictionary to start a fresh reader.';
  }
  // js-mdict often exposes parser internals (for example a missing offset)
  // for corrupt/encrypted files. That stack detail is useful in the console,
  // not in the Preferences panel where the reader needs an actionable answer.
  return 'This MDX file could not be read. It may be damaged, unsupported, encrypted, or not an MDX dictionary.';
}

/**
 * Load dictionaries from absolute paths (dialog-selected or restored).
 * Returns per-file results; never throws.
 */
async function loadMany(filePaths, { enabledFlags = {}, persistAfter = true } = {}) {
  const results = [];
  for (const requested of filePaths) {
    let realPath;
    try {
      realPath = fs.realpathSync(requested);
    } catch {
      results.push({ path: requested, name: displayName(requested), success: false, error: 'File not found' });
      continue;
    }
    if (dictionaries.has(realPath)) {
      const current = dictionaries.get(realPath);
      // Selecting an already-loaded JSON glossary is the natural way to pick
      // up definitions an editor or AI has just added. MDX files are immutable
      // in normal use, so they remain a cheap no-op.
      if (current.kind === 'glossary') {
        results.push(await reload(realPath));
      } else {
        results.push({
          path: realPath, name: current.name, kind: current.kind,
          success: true, alreadyLoaded: true,
        });
      }
      continue;
    }
    try {
      // JSON parses immediately; MDX parsing happens off the main thread.
      const { kind, source, title } = await openBackend(realPath);
      const name = title || displayName(realPath);
      dictionaries.set(realPath, {
        name,
        kind,
        source,
        enabled: enabledFlags[requested] !== false && enabledFlags[realPath] !== false,
        error: '',
      });
      results.push({ path: realPath, name, kind, success: true });
    } catch (err) {
      results.push({
        path: realPath, name: displayName(realPath), success: false,
        error: loadError(err, realPath),
      });
    }
  }
  if (persistAfter) persist();
  return results;
}

/** Find pre-bundled offline dictionaries shipped with the app package. */
function getBundledDictionaryPaths() {
  const dirs = [];
  if (process.resourcesPath) {
    dirs.push(path.join(process.resourcesPath, 'dictionaries'));
  }
  if (typeof app?.getAppPath === 'function') {
    dirs.push(path.join(app.getAppPath(), 'bundled-dictionaries'));
  }
  for (const dir of dirs) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        const files = fs.readdirSync(dir)
          .filter(f => f.endsWith('.json'))
          .sort()
          .map(f => path.join(dir, f));
        if (files.length > 0) return files;
      }
    } catch { /* ignore */ }
  }
  return [];
}

/** Restore saved dictionaries (called after the window is shown). */
async function restoreFromPrefs() {
  const { order, enabled } = store.getPrefs().dictionaries;
  const bundled = getBundledDictionaryPaths();
  const bundledByBase = new Map(bundled.map(p => [path.basename(p), p]));

  const resolved = [];
  for (const p of order) {
    if (fs.existsSync(p)) {
      resolved.push(p);
    } else {
      const base = path.basename(p);
      if (bundledByBase.has(base)) {
        resolved.push(bundledByBase.get(base));
      }
    }
  }

  // If first launch or no dictionaries configured, auto-seed bundled dictionaries
  if (resolved.length === 0 && bundled.length > 0) {
    for (const b of bundled) resolved.push(b);
  }

  if (resolved.length === 0) return [];
  return await loadMany(resolved, { enabledFlags: enabled, persistAfter: true });
}

function list(document = null) {
  return [...dictionaries.entries()].map(([p, d]) => ({
    path: p, name: d.name, enabled: d.enabled, ...metadata(d, document),
  }));
}

/** Re-read one backend without losing the working copy if the new file is bad. */
async function reload(realPath) {
  const current = dictionaries.get(realPath);
  if (!current) return { path: realPath, success: false, error: 'Dictionary is not loaded' };
  let opened;
  try {
    opened = await openBackend(realPath);
  } catch (err) {
    return {
      path: realPath, name: current.name, kind: current.kind, success: false,
      error: loadError(err, realPath),
    };
  }

  try { current.source.close(); } catch { /* best effort */ }
  current.kind = opened.kind;
  current.source = opened.source;
  current.name = opened.title || displayName(realPath);
  current.error = '';
  return {
    path: realPath, name: current.name, kind: current.kind,
    success: true, reloaded: true,
  };
}

function remove(realPath) {
  const dict = dictionaries.get(realPath);
  if (!dict) return { success: false };
  try { dict.source.close(); } catch { /* best effort */ }
  dictionaries.delete(realPath);
  persist();
  return { success: true };
}

function toggle(realPath) {
  const dict = dictionaries.get(realPath);
  if (!dict) return { success: false };
  dict.enabled = !dict.enabled;
  persist();
  return { success: true, enabled: dict.enabled };
}

function reorder(newOrder) {
  if (!Array.isArray(newOrder)) return { success: false };
  const known = newOrder.filter(p => dictionaries.has(p));
  const missing = [...dictionaries.keys()].filter(p => !known.includes(p));
  const finalOrder = [...known, ...missing];
  const reordered = new Map(finalOrder.map(p => [p, dictionaries.get(p)]));
  dictionaries.clear();
  for (const [p, d] of reordered) dictionaries.set(p, d);
  persist();
  return { success: true };
}

/**
 * Look up an ordered candidate list across enabled dictionaries.
 * @returns successful definition records plus a small error record for each
 *          source that stopped responding. Errors are deliberately returned
 *          with the useful results so one bad MDX never hides another source.
 */
async function lookup(candidates, document = null) {
  if (!Array.isArray(candidates)) return [];
  const clean = candidates
    .filter(c => typeof c === 'string' && c.length > 0 && c.length <= MAX_CANDIDATE_LENGTH)
    .slice(0, MAX_CANDIDATES);
  if (clean.length === 0) return [];
  const active = [...dictionaries.entries()].filter(([, dict]) => metadata(dict, document).active);

  const hits = await Promise.all(active.map(async ([dictPath, dict]) => {
    const info = metadata(dict, document);
    if (!info.active) return null;
    try {
      let entry = null;
      let matchedCandidate = '';
      if (typeof dict.source.lookupCandidates === 'function') {
        entry = await dict.source.lookupCandidates(clean);
        matchedCandidate = entry?.matchedCandidate || '';
      } else {
        for (const candidate of clean) {
          entry = dict.source.lookup(candidate);
          if (entry && typeof entry.definition === 'string' && entry.definition.length > 0) {
            matchedCandidate = candidate;
            break;
          }
          entry = null;
        }
      }
      if (entry && typeof entry.definition === 'string' && entry.definition.length > 0) {
        dict.error = '';
        return {
          dictName: dict.name,
          dictKind: dict.kind,
          dictPath,
          keyText: typeof entry.keyText === 'string' ? entry.keyText.slice(0, 300) : matchedCandidate || clean[0],
          matchedCandidate,
          definition: entry.definition.slice(0, MAX_DEFINITION_BYTES),
          example: typeof entry.example === 'string' ? entry.example : '',
          page: Number.isInteger(entry.page) ? entry.page : null,
          count: Number.isInteger(entry.count) ? entry.count : null,
          language: typeof entry.language === 'string' ? entry.language : '',
        };
      }
      return null;
    } catch (error) {
      dict.error = error && error.message
        ? String(error.message).slice(0, 200)
        : 'Dictionary lookup failed';
      console.error(`gloss: lookup failed in ${dict.name}:`, dict.error);
      return {
        dictName: dict.name,
        dictKind: dict.kind,
        dictPath,
        error: dict.error,
      };
    }
  }));
  return hits.filter(Boolean);
}

function hasDictionary(realPath) {
  return dictionaries.has(realPath);
}

function closeAll() {
  for (const dict of dictionaries.values()) {
    try { dict.source.close(); } catch { /* process is quitting */ }
  }
  dictionaries.clear();
}

module.exports = {
  loadMany, restoreFromPrefs, list, reload, remove, toggle, reorder, lookup, hasDictionary, closeAll,
};
