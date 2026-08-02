/**
 * popup.js — the definition popup.
 *
 * All dictionary HTML is hostile input. It passes through DOMPurify with a
 * strict allowlist, and even sanitized links carry no live href: they are
 * rewritten to data-* attributes handled by a delegated click listener, so
 * a sanitizer bypass still cannot navigate, beacon, or open windows
 * (navigation is additionally denied in the main process).
 */

import DOMPurify from '../../node_modules/dompurify/dist/purify.es.mjs';
import { $, esc, show, hide, isShown, announce } from './dom.js';
import { icons } from './icons.js';

const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    'b', 'strong', 'i', 'em', 'u', 'sub', 'sup', 'small', 'font',
    'span', 'div', 'p', 'br', 'hr', 'a', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'blockquote', 'q', 'cite', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
    'ruby', 'rt', 'rp',
  ],
  ALLOWED_ATTR: ['href', 'title', 'lang', 'dir', 'color', 'face'],
  ALLOWED_URI_REGEXP: /^(?:https?:|entry:)/i,
  FORBID_TAGS: [
    'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button',
    'meta', 'base', 'link', 'svg', 'math', 'template', 'noscript',
    'img', 'audio', 'video', 'source', 'track',
  ],
  FORBID_ATTR: ['style', 'target', 'src', 'srcset', 'formaction', 'xlink:href'],
  ALLOW_DATA_ATTR: false,
  USE_PROFILES: { html: true },
};

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName !== 'A') return;
  const href = node.getAttribute('href') || '';
  node.removeAttribute('href');
  node.removeAttribute('target');
  if (/^entry:/i.test(href)) {
    node.setAttribute('data-entry', decodeURIComponentSafe(href.replace(/^entry:\/*/i, '')));
    node.setAttribute('class', 'def-link def-link--entry');
  } else if (/^https?:/i.test(href)) {
    node.setAttribute('data-external', href);
    node.setAttribute('rel', 'noopener noreferrer');
    node.setAttribute('class', 'def-link def-link--external');
  } else if (href) {
    return; // unknown scheme: neutralized by the href removal above
  }
  if (node.hasAttribute('data-entry') || node.hasAttribute('data-external')) {
    node.setAttribute('role', 'link');
    node.setAttribute('tabindex', '0');
  }
});

function decodeURIComponentSafe(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** Exported for security regression tests. */
export function sanitizeDefinition(html) {
  return DOMPurify.sanitize(String(html), SANITIZE_CONFIG);
}

// ── State ─────────────────────────────────────────────────────────────────────

const view = {
  payload: null,       // current render payload
  activeTab: 0,
  pinned: false,
  history: [],         // entry:// navigation stack of payloads
  anchorRect: null,
  onEntryLookup: null, // set by lookup.js
  onExternalOpen: null,
  onRelayout: null,
};

const el = {};
export function init({ onEntryLookup, onExternalOpen }) {
  el.root = $('popup');
  el.word = $('popup-word');
  el.body = $('popup-body');
  el.tabs = $('popup-tabs');
  el.back = $('popup-back');
  el.pin = $('popup-pin');
  el.close = $('popup-close');
  view.onEntryLookup = onEntryLookup;
  view.onExternalOpen = onExternalOpen;

  el.back.innerHTML = icons.back;
  el.pin.innerHTML = icons.pin;
  el.close.innerHTML = icons.close;

  el.close.addEventListener('click', () => closePopup({ force: true }));
  el.pin.addEventListener('click', togglePin);
  el.back.addEventListener('click', goBack);

  el.tabs.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (!tab) return;
    view.activeTab = Number(tab.dataset.tab);
    renderTabs();
    renderBody();
  });

  const activate = (target) => {
    const entry = target.closest('[data-entry]');
    if (entry && view.onEntryLookup) {
      view.history.push({ payload: view.payload, activeTab: view.activeTab });
      view.onEntryLookup(entry.dataset.entry);
      return true;
    }
    const ext = target.closest('[data-external]');
    if (ext && view.onExternalOpen) {
      view.onExternalOpen(ext.dataset.external);
      return true;
    }
    return false;
  };
  el.body.addEventListener('click', (e) => { if (activate(e.target)) e.preventDefault(); });
  el.body.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && activate(e.target)) e.preventDefault();
  });

  // Dismiss on outside pointer-down unless pinned.
  document.addEventListener('pointerdown', (e) => {
    if (!isShown(el.root) || view.pinned) return;
    if (!el.root.contains(e.target)) closePopup();
  });
}

export function isOpen() { return isShown(el.root); }
export function isPinned() { return view.pinned; }

function togglePin() {
  view.pinned = !view.pinned;
  el.pin.innerHTML = view.pinned ? icons.pinned : icons.pin;
  el.pin.setAttribute('aria-pressed', String(view.pinned));
  el.root.classList.toggle('popup--pinned', view.pinned);
}

export function closePopup({ force = false } = {}) {
  if (!isShown(el.root)) return false;
  if (view.pinned && !force) return false;
  hide(el.root);
  el.root.classList.remove('popup--visible');
  view.payload = null;
  view.history = [];
  if (view.pinned) togglePin();
  return true;
}

function goBack() {
  const prev = view.history.pop();
  if (!prev) return;
  view.payload = prev.payload;
  view.activeTab = prev.activeTab;
  renderAll();
}

// ── Positioning ───────────────────────────────────────────────────────────────

const GAP = 10;
const MARGIN = 12;

function position(anchorRect) {
  if (view.pinned) return; // pinned popups stay put
  if (anchorRect) view.anchorRect = anchorRect;
  const rect = view.anchorRect;
  if (!rect) return;
  const pw = el.root.offsetWidth || 360;
  const ph = el.root.offsetHeight || 200;
  let top = rect.bottom + GAP;                 // below the selection…
  if (top + ph > window.innerHeight - MARGIN) {
    top = rect.top - ph - GAP;                 // …or above, never covering it
  }
  if (top < MARGIN) top = MARGIN;
  let left = rect.left;
  if (left + pw > window.innerWidth - MARGIN) left = window.innerWidth - pw - MARGIN;
  if (left < MARGIN) left = MARGIN;
  el.root.style.top = `${Math.round(top)}px`;
  el.root.style.left = `${Math.round(left)}px`;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/**
 * payload = {
 *   word, phase: 'loading' | 'done',
 *   sources: [{kind:'mdx', dictName, keyText, html} | {kind:'wiki', title, extract, url, lang}],
 *   wikiState: 'loading'|'hit'|'miss'|'offline'|'error'|'skipped',
 * }
 */
export function render(payload, anchorRect) {
  const wasOpen = isShown(el.root);
  view.payload = payload;
  if (!wasOpen) { view.history = []; view.activeTab = 0; }
  if (view.activeTab >= Math.max(1, payload.sources.length)) view.activeTab = 0;

  el.word.textContent = payload.word;
  el.back.hidden = view.history.length === 0;
  renderTabs();
  renderBody();

  if (!wasOpen) {
    show(el.root);
    el.root.classList.remove('popup--visible');
    position(anchorRect);
    requestAnimationFrame(() => el.root.classList.add('popup--visible'));
  } else {
    position(anchorRect);
  }
}

function renderAll() {
  el.word.textContent = view.payload.word;
  el.back.hidden = view.history.length === 0;
  renderTabs();
  renderBody();
}

function tabLabel(source) {
  return source.kind === 'wiki'
    ? `Wikipedia (${esc(source.lang)})`
    : esc(source.dictName || 'Dictionary');
}

function renderTabs() {
  const { sources } = view.payload;
  if (sources.length <= 1) { hide(el.tabs); return; }
  show(el.tabs);
  el.tabs.innerHTML = sources.map((s, i) =>
    `<button class="popup-tab${i === view.activeTab ? ' popup-tab--active' : ''}"
             role="tab" aria-selected="${i === view.activeTab}" data-tab="${i}">${tabLabel(s)}</button>`
  ).join('');
}

function renderBody() {
  const { phase, sources, wikiState } = view.payload;
  const parts = [];

  if (phase === 'loading') {
    parts.push(`<div class="popup-state">${icons.spinner}<span>Looking up…</span></div>`);
  } else if (sources.length === 0) {
    if (wikiState === 'loading') {
      parts.push(`<div class="popup-state">${icons.spinner}<span>Checking Wikipedia…</span></div>`);
    } else if (wikiState === 'offline') {
      parts.push(`<div class="popup-state popup-state--muted">${icons.offline}<span>No local match — and Wikipedia is unreachable offline.</span></div>`);
    } else if (wikiState === 'error') {
      parts.push(`<div class="popup-state popup-state--muted"><span>No local match — Wikipedia lookup failed.</span></div>`);
    } else {
      parts.push(`<div class="popup-state popup-state--muted"><span>No definition found.</span></div>`);
    }
  } else {
    const source = sources[Math.min(view.activeTab, sources.length - 1)];
    if (source.kind === 'wiki') {
      parts.push(`
        <span class="source-badge source-badge--wiki">${icons.globe}Wikipedia</span>
        <p class="popup-extract">${esc(source.extract)}</p>
        <a class="def-link def-link--external" role="link" tabindex="0"
           data-external="${esc(source.url)}">Read more on Wikipedia ${icons.external}</a>`);
    } else {
      parts.push(`<span class="source-badge">${icons.book}${esc(source.dictName)}</span>`);
      if (source.keyText && source.keyText !== view.payload.word) {
        parts.push(`<div class="popup-matched">${esc(source.keyText)}</div>`);
      }
      parts.push(`<div class="popup-definition" lang="">${sanitizeDefinition(source.html)}</div>`);
    }
    if (sources.length >= 1 && wikiState === 'loading') {
      parts.push(`<div class="popup-state popup-state--footer">${icons.spinner}<span>Checking Wikipedia…</span></div>`);
    }
  }

  el.body.innerHTML = parts.join('');
  el.body.scrollTop = 0;
}

/** Announce results for screen readers (called once per completed lookup). */
export function announceResult(payload) {
  const n = payload.sources.length;
  if (n === 0) announce(`No definition found for ${payload.word}`);
  else announce(`Definition for ${payload.word}: ${n} ${n === 1 ? 'source' : 'sources'}`);
}
