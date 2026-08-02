/**
 * lookup.js — lookup orchestration.
 *
 * One user action → one lookup. Every lookup takes a monotonically
 * increasing token; any await that resolves after a newer lookup started
 * is discarded, so a slow stale response can never overwrite a newer one.
 */

import { lookupCandidates, collapseWhitespace, trimEdges } from './text.js';
import * as popup from './popup.js';

const CACHE_LIMIT = 200;

let prefs = { wikipediaEnabled: true, wikipediaAsFallback: true, wikipediaLang: 'en' };
let requestToken = 0;
let dictVersion = 0;
const cache = new Map(); // key -> {sources, wikiState}

export function setPrefs(next) {
  const relevant = ['wikipediaEnabled', 'wikipediaAsFallback', 'wikipediaLang'];
  if (relevant.some(k => prefs[k] !== next[k])) cache.clear();
  prefs = { ...prefs, ...next };
}

export function invalidateDictionaries() {
  dictVersion++;
  cache.clear();
}

export function cacheSize() {
  return cache.size;
}

export function clearCache() {
  cache.clear();
}

function cacheKey(primary) {
  return `${dictVersion}|${prefs.wikipediaLang}|${prefs.wikipediaEnabled}|${prefs.wikipediaAsFallback}|${primary}`;
}

function remember(key, value) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, value);
}

/**
 * Look up a raw selection string. The popup shows the query immediately
 * with a loading state; local results land first, Wikipedia after.
 */
export async function lookupSelection(rawText, anchorRect) {
  const displayWord = trimEdges(collapseWhitespace(rawText)) || collapseWhitespace(rawText);
  const candidates = lookupCandidates(rawText);
  if (candidates.length === 0 || !displayWord) return;

  const token = ++requestToken;
  const key = cacheKey(candidates[0]);

  const cached = cache.get(key);
  if (cached) {
    const payload = { word: displayWord, phase: 'done', ...structuredClone(cached) };
    popup.render(payload, anchorRect);
    popup.announceResult(payload);
    return;
  }

  popup.render({ word: displayWord, phase: 'loading', sources: [], wikiState: 'skipped' }, anchorRect);

  let local = [];
  let localErrors = [];
  try {
    local = await window.gloss.lookupDictionaries(candidates);
    localErrors = local.filter(result => result?.error).map(result => result.dictName || 'A local dictionary');
  } catch {
    local = [];
    localErrors = ['Local dictionaries'];
  }
  if (token !== requestToken) return; // superseded

  const sources = local.filter(r => !r.error).map(r => ({
    kind: 'local',
    dictKind: r.dictKind,
    dictName: r.dictName,
    keyText: r.keyText,
    html: r.definition,
    example: r.example || '',
    page: r.page || null,
    count: r.count || null,
    language: r.language || '',
  }));

  const wantWiki = prefs.wikipediaEnabled && (!prefs.wikipediaAsFallback || sources.length === 0);
  let wikiState = wantWiki ? 'loading' : 'skipped';

  const payload = { word: displayWord, phase: 'done', sources, wikiState, localErrors };
  popup.render(payload, anchorRect);

  if (!wantWiki) {
    popup.announceResult(payload);
    if (localErrors.length === 0) remember(key, { sources, wikiState: 'skipped', localErrors: [] });
    return;
  }

  let wiki;
  try {
    wiki = await window.gloss.lookupWikipedia(prefs.wikipediaLang, displayWord);
  } catch {
    wiki = { status: 'error' };
  }
  if (token !== requestToken) return; // superseded

  wikiState = wiki.status;
  const finalSources = wiki.status === 'hit'
    ? [...sources, { kind: 'wiki', title: wiki.title, extract: wiki.extract, url: wiki.url, lang: wiki.lang }]
    : sources;

  const finalPayload = { word: displayWord, phase: 'done', sources: finalSources, wikiState, localErrors };
  popup.render(finalPayload);
  popup.announceResult(finalPayload);

  // Offline/error results are not cached — retry may succeed later.
  if (localErrors.length === 0 && (wikiState === 'hit' || wikiState === 'miss' || wikiState === 'skipped')) {
    remember(key, { sources: finalSources, wikiState, localErrors: [] });
  }
}

/** entry:// cross-reference lookups reuse the same pipeline. */
export function lookupEntry(word) {
  lookupSelection(word, null);
}
