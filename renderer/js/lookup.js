/**
 * lookup.js — lookup orchestration.
 *
 * One user action → one lookup. Every lookup takes a monotonically
 * increasing token; any await that resolves after a newer lookup started
 * is discarded, so a slow stale response can never overwrite a newer one.
 *
 * Tiers, in the order they appear in the popup:
 *   1. local MDX dictionaries and per-book JSON glossaries (always, offline)
 *   2. Wiktionary — the online dictionary: senses, part of speech
 *   3. Wikipedia — the online encyclopedia: what a named thing *is*
 *
 * The two online tiers are requested together rather than in sequence: they
 * are independent, and a reader waiting on a word should wait one round trip,
 * not two.
 */

import { lookupCandidates, collapseWhitespace, trimEdges } from './text.js';
import * as popup from './popup.js';

const CACHE_LIMIT = 200;

let prefs = {
  wiktionaryEnabled: true,
  wiktionaryAsFallback: true,
  wikipediaEnabled: true,
  wikipediaAsFallback: true,
  wikipediaLang: 'en',
  webSearchLinkEnabled: true,
};
let requestToken = 0;
let dictVersion = 0;
const cache = new Map(); // key -> {sources, wikiState, wiktState}

const PREF_KEYS = [
  'wiktionaryEnabled', 'wiktionaryAsFallback',
  'wikipediaEnabled', 'wikipediaAsFallback', 'wikipediaLang',
  'webSearchLinkEnabled',
];

export function setPrefs(next) {
  if (PREF_KEYS.some(k => prefs[k] !== next[k])) cache.clear();
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
  return [dictVersion, ...PREF_KEYS.map(k => prefs[k]), primary].join('|');
}

function remember(key, value) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, value);
}

/** Offline/error results are not cached — a retry may succeed later. */
function cacheable(state) {
  return state === 'hit' || state === 'miss' || state === 'skipped';
}

/**
 * Look up a raw selection string. The popup shows the query immediately
 * with a loading state; local results land first, online sources after.
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
    payload.webSearch = prefs.webSearchLinkEnabled;
    popup.render(payload, anchorRect);
    popup.announceResult(payload);
    return;
  }

  popup.render({
    word: displayWord, phase: 'loading', sources: [],
    wikiState: 'skipped', wiktState: 'skipped', webSearch: prefs.webSearchLinkEnabled,
  }, anchorRect);

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

  const noLocalMatch = sources.length === 0;
  const wantWikt = prefs.wiktionaryEnabled && (!prefs.wiktionaryAsFallback || noLocalMatch);
  const wantWiki = prefs.wikipediaEnabled && (!prefs.wikipediaAsFallback || noLocalMatch);

  const payload = {
    word: displayWord, phase: 'done', sources, localErrors,
    wiktState: wantWikt ? 'loading' : 'skipped',
    wikiState: wantWiki ? 'loading' : 'skipped',
    webSearch: prefs.webSearchLinkEnabled,
  };
  popup.render(payload, anchorRect);

  if (!wantWikt && !wantWiki) {
    popup.announceResult(payload);
    if (localErrors.length === 0) {
      remember(key, { sources, wikiState: 'skipped', wiktState: 'skipped', localErrors: [] });
    }
    return;
  }

  // Both online tiers are independent — one round trip, not two.
  const [wikt, wiki] = await Promise.all([
    wantWikt
      ? window.gloss.lookupWiktionary(prefs.wikipediaLang, displayWord).catch(() => ({ status: 'error' }))
      : Promise.resolve({ status: 'skipped' }),
    wantWiki
      ? window.gloss.lookupWikipedia(prefs.wikipediaLang, displayWord).catch(() => ({ status: 'error' }))
      : Promise.resolve({ status: 'skipped' }),
  ]);
  if (token !== requestToken) return; // superseded

  const wiktState = wikt.status;
  const wikiState = wiki.status;

  // Wiktionary sits ahead of Wikipedia: for a word met while reading, the
  // dictionary sense is the answer and the encyclopedia article is context.
  const finalSources = [...sources];
  if (wiktState === 'hit') {
    finalSources.push({
      kind: 'wiktionary', word: wikt.word, sections: wikt.sections, url: wikt.url,
    });
  }
  if (wikiState === 'hit') {
    finalSources.push({
      kind: 'wiki', title: wiki.title, extract: wiki.extract, url: wiki.url, lang: wiki.lang,
    });
  }

  const finalPayload = {
    word: displayWord, phase: 'done', sources: finalSources,
    wikiState, wiktState, localErrors, webSearch: prefs.webSearchLinkEnabled,
  };
  popup.render(finalPayload);
  popup.announceResult(finalPayload);

  if (localErrors.length === 0 && cacheable(wikiState) && cacheable(wiktState)) {
    remember(key, { sources: finalSources, wikiState, wiktState, localErrors: [] });
  }
}

/** entry:// cross-reference lookups reuse the same pipeline. */
export function lookupEntry(word) {
  lookupSelection(word, null);
}
