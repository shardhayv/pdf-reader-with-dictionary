/**
 * sidebar.js — thumbnails and document outline.
 *
 * Thumbnails render lazily (IntersectionObserver over the sidebar scroll
 * area) into small JPEG object URLs, so a 500-page document costs a few
 * megabytes, not gigabytes. URLs are revoked on document close.
 */

import { refs, $, esc, show, hide } from './dom.js';
import { icons } from './icons.js';
import * as viewer from './viewer.js';

const THUMB_WIDTH = 108;

/** Below this width the sidebar floats over the page (see style.css). */
const floatingQuery = window.matchMedia('(max-width: 760px)');

const state = {
  visible: false,
  tab: 'thumbnails',
  observer: null,
  urls: new Map(),        // page -> object URL
  pending: new Set(),
  onVisibilityChange: null,
  onTabChange: null,
  getSavedWords: null,
  onRemoveSavedWord: null,
  onLookupSavedWord: null,
  onExportSavedWords: null,
};

let els = null;

export function init({
  onVisibilityChange,
  onTabChange,
  getSavedWords,
  onRemoveSavedWord,
  onLookupSavedWord,
  onExportSavedWords,
} = {}) {
  els = {
    root: refs.sidebar(),
    scrim: $('sidebar-scrim'),
    toggle: $('btn-sidebar'),
    tabThumbs: document.getElementById('sidebar-tab-thumbnails'),
    tabOutline: document.getElementById('sidebar-tab-outline'),
    tabBookmarks: document.getElementById('sidebar-tab-bookmarks'),
    thumbs: document.getElementById('sidebar-thumbnails'),
    outline: document.getElementById('sidebar-outline'),
    bookmarks: document.getElementById('sidebar-bookmarks'),
  };
  state.onVisibilityChange = onVisibilityChange;
  state.onTabChange = onTabChange;
  state.getSavedWords = getSavedWords;
  state.onRemoveSavedWord = onRemoveSavedWord;
  state.onLookupSavedWord = onLookupSavedWord;
  state.onExportSavedWords = onExportSavedWords;

  els.tabThumbs.addEventListener('click', () => setTab('thumbnails', { notify: true }));
  els.tabOutline.addEventListener('click', () => setTab('outline', { notify: true }));
  els.tabBookmarks?.addEventListener('click', () => setTab('bookmarks', { notify: true }));

  // Floating over the page, a press on the dimmed page puts the sidebar away.
  els.scrim?.addEventListener('click', () => setVisible(false));

  // Left/Right move between the three tabs, as a tab list should.
  const tabs = [els.tabThumbs, els.tabOutline, els.tabBookmarks].filter(Boolean);
  const tabNames = ['thumbnails', 'outline', 'bookmarks'];
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      e.stopPropagation(); // not a page turn
      const next = (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      setTab(tabNames[next], { notify: true });
      tabs[next].focus();
    });
  }

  els.thumbs.addEventListener('click', (e) => {
    const item = e.target.closest('[data-thumb-page]');
    if (item) viewer.goToPage(Number(item.dataset.thumbPage), { instant: true, recordHistory: true });
  });

  els.outline.addEventListener('click', async (e) => {
    const toggle = e.target.closest('[data-outline-toggle]');
    if (toggle) {
      toggle.closest('li')?.classList.toggle('outline-item--collapsed');
      toggle.setAttribute('aria-expanded',
        String(!toggle.closest('li')?.classList.contains('outline-item--collapsed')));
      return;
    }
    const link = e.target.closest('[data-outline-index]');
    if (!link) return;
    const dest = outlineDests[Number(link.dataset.outlineIndex)];
    if (dest === undefined) return;
    try {
      const page = await viewer.resolveDestination(dest);
      if (page) viewer.goToPage(page, { instant: true, recordHistory: true });
    } catch (error) {
      // A malformed outline must never take the reader down with it. pdf.js
      // normally returns null for bad destinations; this boundary also covers
      // unexpected renderer errors and leaves page navigation usable.
      console.error('Gloss could not follow that outline destination:', error);
    }
  });

  viewer.on('documentopened', buildForDocument);
  viewer.on('documentclosed', teardown);
  viewer.on('pagechanged', (p) => {
    markCurrentPage(p);
    if (state.tab === 'bookmarks') renderBookmarksPanel();
  });
  viewer.on('bookmarkschanged', () => {
    renderBookmarksPanel();
  });
  viewer.on('rotationchanged', () => {
    if (!viewer.hasDocument()) return;
    state.observer?.disconnect();
    state.observer = null;
    for (const url of state.urls.values()) URL.revokeObjectURL(url);
    state.urls.clear();
    state.pending.clear();
    buildThumbnails();
    markCurrentPage(viewer.currentPage());
  });
}

export function isVisible() { return state.visible; }
export function currentTab() { return state.tab; }

/** True while the sidebar is open *and* floating over the page. */
export function isFloating() {
  return state.visible && floatingQuery.matches;
}

export function setVisible(visible) {
  state.visible = !!visible;
  if (state.visible) show(els.root); else hide(els.root);
  if (els.scrim) els.scrim.hidden = !state.visible;
  els.toggle?.setAttribute('aria-pressed', String(state.visible));
  viewer.handleResize(); // fit modes depend on container width
  // Page changes are ignored while hidden, so re-sync on open — otherwise
  // the sidebar shows no current page until you next navigate.
  if (state.visible) markCurrentPage(viewer.currentPage());
  state.onVisibilityChange?.(state.visible);
}

export function toggle() { setVisible(!state.visible); }

export function setTab(tab, { notify = false } = {}) {
  state.tab = (tab === 'outline' || tab === 'bookmarks') ? tab : 'thumbnails';
  const isThumbs = state.tab === 'thumbnails';
  const isOutline = state.tab === 'outline';
  const isBookmarks = state.tab === 'bookmarks';
  els.tabThumbs.classList.toggle('sidebar-tab--active', isThumbs);
  els.tabOutline.classList.toggle('sidebar-tab--active', isOutline);
  els.tabBookmarks?.classList.toggle('sidebar-tab--active', isBookmarks);
  els.tabThumbs.setAttribute('aria-selected', String(isThumbs));
  els.tabOutline.setAttribute('aria-selected', String(isOutline));
  els.tabBookmarks?.setAttribute('aria-selected', String(isBookmarks));
  // Roving tabindex: one stop for the tab list, arrows within it.
  els.tabThumbs.tabIndex = isThumbs ? 0 : -1;
  els.tabOutline.tabIndex = isOutline ? 0 : -1;
  if (els.tabBookmarks) els.tabBookmarks.tabIndex = isBookmarks ? 0 : -1;
  if (isThumbs) show(els.thumbs); else hide(els.thumbs);
  if (isOutline) show(els.outline); else hide(els.outline);
  if (els.bookmarks) {
    if (isBookmarks) {
      renderBookmarksPanel();
      show(els.bookmarks);
    } else {
      hide(els.bookmarks);
    }
  }
  if (notify) state.onTabChange?.(state.tab);
}

export function refreshSavedPanel() {
  if (els?.bookmarks) renderBookmarksPanel();
}

// ── Build / teardown ──────────────────────────────────────────────────────────

let outlineDests = [];

function buildForDocument() {
  teardown();
  buildThumbnails();
  buildOutline().catch(error => {
    console.error('Gloss could not build the document outline:', error);
    if (els) els.outline.innerHTML = '<p class="sidebar-empty">The document outline could not be read.</p>';
  });
  renderBookmarksPanel();
  markCurrentPage(viewer.currentPage());
}

function teardown() {
  state.observer?.disconnect();
  state.observer = null;
  for (const url of state.urls.values()) URL.revokeObjectURL(url);
  state.urls.clear();
  state.pending.clear();
  outlineDests = [];
  if (els) {
    els.thumbs.replaceChildren();
    els.outline.replaceChildren();
    renderBookmarksPanel();
  }
}

// ── Thumbnails ────────────────────────────────────────────────────────────────

function buildThumbnails() {
  const total = viewer.pageCount();
  const frag = document.createDocumentFragment();
  for (let n = 1; n <= total; n++) {
    const item = document.createElement('button');
    item.className = 'thumb';
    item.dataset.thumbPage = String(n);
    item.setAttribute('aria-label', `Page ${n}`);
    item.innerHTML = `<span class="thumb-frame"></span><span class="thumb-num">${n}</span>`;
    frag.appendChild(item);
  }
  els.thumbs.replaceChildren(frag);

  state.observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const n = Number(entry.target.dataset.thumbPage);
      state.observer.unobserve(entry.target);
      loadThumbnail(n, entry.target).catch(error => {
        state.pending.delete(n);
        console.error(`Gloss could not render thumbnail ${n}:`, error);
      });
    }
  }, { root: els.thumbs, rootMargin: '300px 0px' });

  for (const item of els.thumbs.children) state.observer.observe(item);
}

async function loadThumbnail(n, item) {
  if (state.urls.has(n) || state.pending.has(n)) return;
  state.pending.add(n);
  const url = await viewer.renderThumbnail(n, THUMB_WIDTH);
  state.pending.delete(n);
  if (!url) return;
  if (!item.isConnected) { URL.revokeObjectURL(url); return; }
  state.urls.set(n, url);
  const img = document.createElement('img');
  img.src = url;
  img.alt = '';
  img.decoding = 'async';
  item.querySelector('.thumb-frame')?.replaceChildren(img);
}

function markCurrentPage(page) {
  if (!els || !state.visible) return;
  for (const item of els.thumbs.querySelectorAll('.thumb--current')) {
    item.classList.remove('thumb--current');
  }
  const current = els.thumbs.querySelector(`[data-thumb-page="${page}"]`);
  if (current) {
    current.classList.add('thumb--current');
    current.scrollIntoView({ block: 'nearest' });
  }
}

// ── Outline ───────────────────────────────────────────────────────────────────

async function buildOutline() {
  const outline = await viewer.getOutline();
  if (!outline || outline.length === 0) {
    els.outline.innerHTML = '<p class="sidebar-empty">This document has no outline.</p>';
    return;
  }
  outlineDests = [];
  els.outline.innerHTML = `<ul class="outline-list" role="tree">${outline.map(renderOutlineItem).join('')}</ul>`;
}

function renderOutlineItem(item) {
  const index = outlineDests.push(item.dest) - 1;
  const children = Array.isArray(item.items) && item.items.length > 0
    ? `<ul class="outline-list">${item.items.map(renderOutlineItem).join('')}</ul>`
    : '';
  const toggle = children
    ? `<button class="outline-toggle" data-outline-toggle aria-expanded="true" aria-label="Collapse section">${icons.chevronRight}</button>`
    : '<span class="outline-spacer"></span>';
  return `<li class="outline-item" role="treeitem">
    <div class="outline-row">${toggle}
      <button class="outline-link" data-outline-index="${index}">${esc(item.title || 'Untitled')}</button>
    </div>${children}</li>`;
}

// ── Bookmarks & Saved Vocabulary ──────────────────────────────────────────────

function renderBookmarksPanel() {
  if (!els?.bookmarks) return;
  const hasDoc = viewer.hasDocument();
  const pageBookmarks = hasDoc ? viewer.bookmarks() : [];
  const curPage = hasDoc ? viewer.currentPage() : 1;
  const curBookmarked = hasDoc && viewer.isBookmarked(curPage);
  const savedWords = state.getSavedWords?.() || [];

  const pageRows = !hasDoc
    ? '<p class="sidebar-empty">Open a PDF to bookmark pages.</p>'
    : pageBookmarks.length === 0
      ? '<p class="sidebar-empty">No bookmarked pages yet. Press Ctrl+B to bookmark the current page.</p>'
      : `<div class="saved-list">${pageBookmarks.map(p => `
          <div class="saved-row${p === curPage ? ' saved-row--active' : ''}">
            <button class="saved-jump" data-bookmark-page="${p}" title="Jump to page ${p}">
              ${icons.bookmarkFilled}<span>Page ${p}</span>
            </button>
            <button class="icon-btn icon-btn--sm" data-remove-bookmark="${p}" aria-label="Remove page ${p} bookmark" title="Remove bookmark">${icons.close}</button>
          </div>`).join('')}</div>`;

  const vocabRows = savedWords.length === 0
    ? '<p class="sidebar-empty">No saved words yet. Click the star in any definition popup (or press S) to save words to your vocabulary notebook.</p>'
    : `<div class="saved-list">${savedWords.map((item, idx) => `
        <div class="saved-word-card">
          <div class="saved-word-head">
            <button class="saved-word-btn" data-vocab-word="${esc(item.word)}" title="Look up ${esc(item.word)}">
              <strong>${esc(item.word)}</strong>
              ${item.source ? `<span class="saved-word-badge">${esc(item.source)}</span>` : ''}
            </button>
            <button class="icon-btn icon-btn--sm" data-remove-vocab="${idx}" aria-label="Remove ${esc(item.word)}" title="Remove from vocabulary">${icons.close}</button>
          </div>
          ${item.definition ? `<p class="saved-word-def">${esc(item.definition.slice(0, 140))}${item.definition.length > 140 ? '…' : ''}</p>` : ''}
          ${item.docName ? `<div class="saved-word-meta">${esc(item.docName)}${item.page ? ` · p. ${item.page}` : ''}</div>` : ''}
        </div>`).join('')}</div>`;

  els.bookmarks.innerHTML = `
    <div class="saved-section">
      <div class="saved-section-head">
        <span class="saved-section-title">Bookmarked pages</span>
        ${hasDoc ? `<button class="btn btn--xs" id="sidebar-toggle-bookmark">${curBookmarked ? 'Remove p. ' + curPage : '+ Page ' + curPage}</button>` : ''}
      </div>
      ${pageRows}
    </div>
    <div class="saved-section">
      <div class="saved-section-head">
        <span class="saved-section-title">Vocabulary (${savedWords.length})</span>
        ${savedWords.length > 0 ? `<button class="btn btn--xs" id="sidebar-export-vocab" title="Copy vocabulary as Markdown">${icons.copy}Export</button>` : ''}
      </div>
      ${vocabRows}
    </div>`;

  els.bookmarks.querySelector('#sidebar-toggle-bookmark')?.addEventListener('click', () => {
    viewer.toggleBookmark(viewer.currentPage());
  });
  els.bookmarks.querySelector('#sidebar-export-vocab')?.addEventListener('click', () => {
    state.onExportSavedWords?.();
  });
  for (const btn of els.bookmarks.querySelectorAll('[data-bookmark-page]')) {
    btn.addEventListener('click', () => {
      viewer.goToPage(Number(btn.dataset.bookmarkPage), { instant: true, recordHistory: true });
    });
  }
  for (const btn of els.bookmarks.querySelectorAll('[data-remove-bookmark]')) {
    btn.addEventListener('click', () => {
      viewer.removeBookmark(Number(btn.dataset.removeBookmark));
    });
  }
  for (const btn of els.bookmarks.querySelectorAll('[data-vocab-word]')) {
    btn.addEventListener('click', () => {
      state.onLookupSavedWord?.(btn.dataset.vocabWord);
    });
  }
  for (const btn of els.bookmarks.querySelectorAll('[data-remove-vocab]')) {
    btn.addEventListener('click', () => {
      state.onRemoveSavedWord?.(Number(btn.dataset.removeVocab));
    });
  }
}
