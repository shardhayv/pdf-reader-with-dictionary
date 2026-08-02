'use strict';
/**
 * MDX dictionary registry (main process).
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
const store = require('./store');

const MAX_CANDIDATES = 10;
const MAX_CANDIDATE_LENGTH = 120;
const MAX_DEFINITION_BYTES = 512 * 1024;

/** realpath -> { name, mdx, enabled } */
const dictionaries = new Map();

let MDX = null;
function getMDX() {
  if (!MDX) ({ MDX } = require('js-mdict'));
  return MDX;
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

/**
 * Load dictionaries from absolute paths (dialog-selected or restored).
 * Returns per-file results; never throws.
 */
function loadMany(filePaths, { enabledFlags = {}, persistAfter = true } = {}) {
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
      results.push({ path: realPath, name: dictionaries.get(realPath).name, success: true, alreadyLoaded: true });
      continue;
    }
    try {
      const mdx = new (getMDX())(realPath); // synchronous parse; large files can take a moment
      dictionaries.set(realPath, {
        name: displayName(realPath),
        mdx,
        enabled: enabledFlags[requested] !== false && enabledFlags[realPath] !== false,
      });
      results.push({ path: realPath, name: displayName(realPath), success: true });
    } catch (err) {
      results.push({
        path: realPath, name: displayName(realPath), success: false,
        error: err && err.message ? String(err.message).slice(0, 200) : 'Unreadable dictionary',
      });
    }
  }
  if (persistAfter) persist();
  return results;
}

/** Restore saved dictionaries (called after the window is shown). */
function restoreFromPrefs() {
  const { order, enabled } = store.getPrefs().dictionaries;
  const existing = order.filter(p => fs.existsSync(p));
  if (existing.length === 0) return [];
  return loadMany(existing, { enabledFlags: enabled, persistAfter: true });
}

function list() {
  return [...dictionaries.entries()].map(([p, d]) => ({ path: p, name: d.name, enabled: d.enabled }));
}

function remove(realPath) {
  const dict = dictionaries.get(realPath);
  if (!dict) return { success: false };
  try { dict.mdx.close(); } catch { /* best effort */ }
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
 * @returns [{ dictName, dictPath, keyText, matchedCandidate, definition }]
 */
function lookup(candidates) {
  if (!Array.isArray(candidates)) return [];
  const clean = candidates
    .filter(c => typeof c === 'string' && c.length > 0 && c.length <= MAX_CANDIDATE_LENGTH)
    .slice(0, MAX_CANDIDATES);
  const results = [];
  for (const [dictPath, dict] of dictionaries) {
    if (!dict.enabled) continue;
    for (const candidate of clean) {
      let entry = null;
      try {
        entry = dict.mdx.lookup(candidate);
      } catch {
        continue;
      }
      if (entry && typeof entry.definition === 'string' && entry.definition.length > 0) {
        results.push({
          dictName: dict.name,
          dictPath,
          keyText: typeof entry.keyText === 'string' ? entry.keyText.slice(0, 300) : candidate,
          matchedCandidate: candidate,
          definition: entry.definition.slice(0, MAX_DEFINITION_BYTES),
        });
        break; // first hit per dictionary wins
      }
    }
  }
  return results;
}

function hasDictionary(realPath) {
  return dictionaries.has(realPath);
}

module.exports = { loadMany, restoreFromPrefs, list, remove, toggle, reorder, lookup, hasDictionary };
