/**
 * sidebar.js — thumbnails and document outline.
 *
 * Thumbnails render lazily (IntersectionObserver over the sidebar scroll
 * area) into small JPEG object URLs, so a 500-page document costs a few
 * megabytes, not gigabytes. URLs are revoked on document close.
 */

import { refs, esc, show, hide } from './dom.js';
import { icons } from './icons.js';
import * as viewer from './viewer.js';

const THUMB_WIDTH = 108;

const state = {
  visible: false,
  tab: 'thumbnails',
  observer: null,
  urls: new Map(),        // page -> object URL
  pending: new Set(),
  onVisibilityChange: null,
};

let els = null;

export function init({ onVisibilityChange } = {}) {
  els = {
    root: refs.sidebar(),
    tabThumbs: document.getElementById('sidebar-tab-thumbnails'),
    tabOutline: document.getElementById('sidebar-tab-outline'),
    thumbs: document.getElementById('sidebar-thumbnails'),
    outline: document.getElementById('sidebar-outline'),
  };
  state.onVisibilityChange = onVisibilityChange;

  els.tabThumbs.addEventListener('click', () => setTab('thumbnails'));
  els.tabOutline.addEventListener('click', () => setTab('outline'));

  els.thumbs.addEventListener('click', (e) => {
    const item = e.target.closest('[data-thumb-page]');
    if (item) viewer.goToPage(Number(item.dataset.thumbPage), { recordHistory: true });
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
      if (page) viewer.goToPage(page, { recordHistory: true });
    } catch (error) {
      // A malformed outline must never take the reader down with it. pdf.js
      // normally returns null for bad destinations; this boundary also covers
      // unexpected renderer errors and leaves page navigation usable.
      console.error('Gloss could not follow that outline destination:', error);
    }
  });

  viewer.on('documentopened', buildForDocument);
  viewer.on('documentclosed', teardown);
  viewer.on('pagechanged', markCurrentPage);
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

export function setVisible(visible) {
  state.visible = !!visible;
  if (state.visible) show(els.root); else hide(els.root);
  viewer.handleResize(); // fit modes depend on container width
  // Page changes are ignored while hidden, so re-sync on open — otherwise
  // the sidebar shows no current page until you next navigate.
  if (state.visible) markCurrentPage(viewer.currentPage());
  state.onVisibilityChange?.(state.visible);
}

export function toggle() { setVisible(!state.visible); }

export function setTab(tab) {
  state.tab = tab === 'outline' ? 'outline' : 'thumbnails';
  const thumbs = state.tab === 'thumbnails';
  els.tabThumbs.classList.toggle('sidebar-tab--active', thumbs);
  els.tabOutline.classList.toggle('sidebar-tab--active', !thumbs);
  els.tabThumbs.setAttribute('aria-selected', String(thumbs));
  els.tabOutline.setAttribute('aria-selected', String(!thumbs));
  if (thumbs) { show(els.thumbs); hide(els.outline); }
  else { hide(els.thumbs); show(els.outline); }
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
