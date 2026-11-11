/**
 * search.js — Unicode-aware full-document search.
 *
 * Page text is extracted lazily and indexed with a grapheme-safe
 * NFC + casefold map (renderer/js/text.js), so Latin and Devanagari
 * queries both match and a match can never split a conjunct. Highlights
 * use the CSS Custom Highlight API — no DOM mutation of the pdf.js text
 * layer — and are (re)applied as virtualized pages render and recycle.
 */

import { refs, show, hide, isShown, announce, debounce, scrollBehavior } from './dom.js';
import { buildSearchIndex, findMatches } from './text.js';
import * as viewer from './viewer.js';

const QUERY_DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 2;

const state = {
  active: false,
  query: '',
  runId: 0,
  indexes: new Map(),   // page -> {norm, map}
  matches: [],          // [{page, start, end}] in document order
  perPage: new Map(),   // page -> [{start, end}]
  current: -1,
  failedPages: 0,
};

let els = null;
let scheduleRun = null;

/**
 * Abandon any in-flight or scheduled search. Without this, closing the find
 * bar (or switching documents) leaves a running scan that keeps extracting
 * pages and then scrolls the reader to a result the user can no longer see.
 */
function abandonSearch() {
  scheduleRun?.cancel();
  state.runId++;
}

export function init() {
  els = {
    bar: refs.searchBar(),
    input: refs.searchInput(),
    count: refs.searchCount(),
    prev: document.getElementById('search-prev'),
    next: document.getElementById('search-next'),
    close: document.getElementById('search-close'),
  };

  scheduleRun = debounce(() => runSearch(els.input.value).catch(showSearchFailure), QUERY_DEBOUNCE_MS);
  els.input.addEventListener('input', scheduleRun);
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      goToRelative(e.shiftKey ? -1 : 1);
    }
  });
  els.prev.addEventListener('click', () => goToRelative(-1));
  els.next.addEventListener('click', () => goToRelative(1));
  els.close.addEventListener('click', closeSearch);

  viewer.on('pagerendered', (n) => {
    if (state.perPage.has(n)) rebuildHighlights();
  });
  viewer.on('pagedestroyed', (n) => {
    if (state.perPage.has(n)) rebuildHighlights();
  });
  viewer.on('documentclosed', resetForNewDocument);
}

export function isActive() { return state.active; }

export function openSearch() {
  if (!viewer.hasDocument()) return;
  state.active = true;
  show(els.bar);
  els.input.focus();
  els.input.select();
  // Reopening with a query still in the box re-runs it, so what is shown
  // always matches what is typed.
  if (els.input.value.trim().length >= MIN_QUERY_LENGTH && state.matches.length === 0) {
    runSearch(els.input.value).catch(showSearchFailure);
  }
}

export function closeSearch() {
  if (!els || !isShown(els.bar)) return;
  state.active = false;
  abandonSearch();
  hide(els.bar);
  clearResults();
  els.count.textContent = '';
  refs.container().focus();
}

export function resetForNewDocument() {
  abandonSearch();
  state.indexes.clear();
  clearResults();
  state.query = '';
  if (els) { els.input.value = ''; els.count.textContent = ''; }
}

function clearResults() {
  state.matches = [];
  state.perPage.clear();
  state.current = -1;
  state.failedPages = 0;
  CSS.highlights.delete('gloss-search');
  CSS.highlights.delete('gloss-search-current');
}

function showSearchFailure(error) {
  console.error('Gloss search failed:', error);
  clearResults();
  if (els) els.count.textContent = 'Search unavailable';
  announce('Search could not finish. Your document is still open.');
}

// ── Search run ────────────────────────────────────────────────────────────────

async function ensureIndex(page) {
  if (state.indexes.has(page)) return state.indexes.get(page);
  const { text } = await viewer.getPageText(page); // also fills the items cache
  const index = buildSearchIndex(text);
  state.indexes.set(page, index);
  return index;
}

async function runSearch(rawQuery) {
  const query = rawQuery.trim();
  state.query = query;
  const runId = ++state.runId;
  const docGeneration = viewer.documentGeneration();
  clearResults();

  if (query.length < MIN_QUERY_LENGTH || !viewer.hasDocument()) {
    els.count.textContent = '';
    return;
  }

  // Results accumulate privately and are published only if this run is still
  // the current one, so an abandoned scan can never leave partial results
  // (or a stale result count) behind.
  const matches = [];
  const perPage = new Map();
  let failedPages = 0;
  const superseded = () => runId !== state.runId || docGeneration !== viewer.documentGeneration();

  const total = viewer.pageCount();
  for (let page = 1; page <= total; page++) {
    let index;
    try {
      index = await ensureIndex(page);
    } catch (error) {
      if (superseded()) return;
      // One malformed page must not make search unusable for the rest of a
      // long book. Keep going and make the partial scope explicit.
      console.warn(`gloss: text extraction failed on page ${page}:`, error?.message || error);
      failedPages++;
      continue;
    }
    if (superseded()) return;
    for (const m of findMatches(index, query)) {
      const entry = { page, start: m.start, end: m.end };
      matches.push(entry);
      if (!perPage.has(page)) perPage.set(page, []);
      perPage.get(page).push(entry);
    }
    if (page % 20 === 0) {
      els.count.textContent = `Searching… ${Math.round((page / total) * 100)}%`;
      await new Promise(r => setTimeout(r, 0)); // keep typing responsive
      if (superseded()) return;
    }
  }

  if (superseded()) return;
  state.matches = matches;
  state.perPage = perPage;
  state.failedPages = failedPages;

  rebuildHighlights();
  if (state.matches.length > 0) {
    announce(`${state.matches.length} results for ${query}`);
    goToMatch(0);
  } else {
    els.count.textContent = failedPages > 0
      ? `No results · ${failedPages} ${failedPages === 1 ? 'page' : 'pages'} unreadable`
      : 'No results';
    announce(failedPages > 0
      ? `No results for ${query}; ${failedPages} pages could not be searched`
      : `No results for ${query}`);
  }
}

// ── Highlighting ──────────────────────────────────────────────────────────────

/** Map a page-text range onto DOM Ranges inside that page's text divs. */
function rangesFor(page, start, end) {
  const divs = viewer.textDivsFor(page);
  const cached = viewer.getPageTextCached(page);
  if (!divs || !cached) return [];
  const out = [];
  for (let i = 0; i < cached.items.length; i++) {
    const item = cached.items[i];
    if (item.start >= end) break;
    if (item.end <= start || item.end === item.start) continue;
    const node = divs[i]?.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) continue;
    const localStart = Math.max(0, start - item.start);
    const localEnd = Math.min(item.end - item.start, end - item.start);
    if (localEnd <= localStart) continue;
    try {
      const range = new Range();
      range.setStart(node, Math.min(localStart, node.length));
      range.setEnd(node, Math.min(localEnd, node.length));
      out.push(range);
    } catch { /* text layer replaced underneath us — skip this range */ }
  }
  return out;
}

function rebuildHighlights() {
  const all = new Highlight();
  for (const [page, entries] of state.perPage) {
    if (!viewer.textDivsFor(page)) continue;
    for (const m of entries) {
      for (const r of rangesFor(page, m.start, m.end)) all.add(r);
    }
  }
  CSS.highlights.set('gloss-search', all);

  const current = new Highlight();
  const m = state.matches[state.current];
  if (m && viewer.textDivsFor(m.page)) {
    for (const r of rangesFor(m.page, m.start, m.end)) current.add(r);
  }
  CSS.highlights.set('gloss-search-current', current);
}

// ── Navigation ────────────────────────────────────────────────────────────────

function updateCount() {
  els.count.textContent = state.matches.length > 0
    ? `${state.current + 1} / ${state.matches.length}${state.failedPages > 0 ? ` · ${state.failedPages} pages unreadable` : ''}`
    : state.failedPages > 0 ? `No results · ${state.failedPages} pages unreadable` : 'No results';
}

function goToRelative(delta) {
  if (state.matches.length === 0) return;
  goToMatch((state.current + delta + state.matches.length) % state.matches.length);
}

async function goToMatch(index) {
  const m = state.matches[index];
  if (!m) return;
  state.current = index;
  updateCount();
  announce(`Result ${index + 1} of ${state.matches.length}`);

  viewer.goToPage(m.page, { instant: true, recordHistory: true });
  await viewer.ensureRendered(m.page);
  rebuildHighlights();

  const target = rangesFor(m.page, m.start, m.end)[0]?.startContainer?.parentElement;
  if (target) target.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
}
