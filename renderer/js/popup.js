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
import { $, esc, show, hide, isShown, announce, toast } from './dom.js';
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

/**
 * Remove presentation-only markup before DOMPurify parses the definition.
 *
 * DOMPurify remains the security boundary and removes these again. This small
 * prefilter exists for a different reason: Chromium applies the document CSP
 * while parsing detached dictionary HTML, so a harmless `style` attribute in
 * a real MDX produces a console violation even though DOMPurify discards it
 * before insertion. Removing only style blocks/attributes up front keeps real
 * dictionaries quiet without trusting or trying to interpret their CSS.
 */
function stripPresentationMarkup(html) {
  return String(html)
    .replace(/<style\b[^>]*>[\s\S]*?(?:<\/style\s*>|$)/gi, '')
    .replace(/\sstyle\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi, '');
}

/** Exported for security regression tests. */
export function sanitizeDefinition(html) {
  return DOMPurify.sanitize(stripPresentationMarkup(html), SANITIZE_CONFIG);
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
  onToggleSaveWord: null,
  isWordSaved: null,
  onRelayout: null,
};

const el = {};
export function init({ onEntryLookup, onExternalOpen, onToggleSaveWord, isWordSaved }) {
  el.root = $('popup');
  el.head = el.root.querySelector('.popup-head');
  el.word = $('popup-word');
  el.body = $('popup-body');
  el.tabs = $('popup-tabs');
  el.back = $('popup-back');
  el.save = $('popup-save');
  el.copy = $('popup-copy');
  el.pin = $('popup-pin');
  el.close = $('popup-close');
  view.onEntryLookup = onEntryLookup;
  view.onExternalOpen = onExternalOpen;
  view.onToggleSaveWord = onToggleSaveWord;
  view.isWordSaved = isWordSaved;

  el.back.innerHTML = icons.back;
  if (el.save) el.save.innerHTML = icons.star;
  if (el.copy) el.copy.innerHTML = icons.copy;
  el.pin.innerHTML = icons.pin;
  el.close.innerHTML = icons.close;

  el.close.addEventListener('click', () => closePopup({ force: true }));
  el.pin.addEventListener('click', togglePin);
  el.back.addEventListener('click', goBack);
  el.save?.addEventListener('click', toggleSaveCurrentWord);
  el.copy?.addEventListener('click', copyDefinition);
  wireDrag();

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

export function selectTab(index) {
  if (!isShown(el.root) || !view.payload?.sources) return false;
  if (index < 0 || index >= view.payload.sources.length) return false;
  view.activeTab = index;
  renderTabs();
  renderBody();
  return true;
}

export function syncSaveState() {
  if (!el.save || !view.payload?.word) return;
  const saved = Boolean(view.isWordSaved?.(view.payload.word));
  el.save.innerHTML = saved ? icons.starFilled : icons.star;
  el.save.setAttribute('aria-pressed', String(saved));
  el.save.title = saved ? 'Remove from saved vocabulary (S)' : 'Save word to vocabulary (S)';
}

/**
 * The definition as plain text — just the definition.
 *
 * The popup body also holds its own furniture: the source badge, the "Read
 * more" and "Search the web" links, status lines. Reading innerText of the
 * whole body and pattern-matching those back out was fragile (the badge is
 * upper-cased by CSS, so innerText returned it upper-cased and the match
 * missed). Instead that furniture is hidden for the instant the text is
 * read; innerText skips hidden elements and still lays out lists and
 * paragraphs on their own lines.
 */
function definitionText() {
  el.body.classList.add('popup-body--plain');
  try {
    return el.body.innerText.replace(/\n{3,}/g, '\n\n').trim();
  } finally {
    el.body.classList.remove('popup-body--plain');
  }
}

function activeSource() {
  const sources = view.payload?.sources || [];
  return sources[Math.min(view.activeTab, Math.max(0, sources.length - 1))] || null;
}

export async function toggleSaveCurrentWord() {
  if (!view.payload?.word || !view.onToggleSaveWord) return false;
  // Nothing worth keeping while the answer is still on its way.
  if (view.payload.phase === 'loading') return false;
  const source = activeSource();
  await view.onToggleSaveWord({
    word: view.payload.word,
    definition: definitionText().slice(0, 600),
    source: source ? sourceLabel(source) : '',
  });
  syncSaveState();
  return true;
}

let copyResetTimer = null;
async function copyDefinition() {
  if (!view.payload) return;
  const bodyText = definitionText();
  const text = bodyText ? `${view.payload.word}\n${bodyText}` : view.payload.word;
  try {
    await navigator.clipboard.writeText(text);
    if (el.copy) {
      el.copy.innerHTML = icons.check;
      clearTimeout(copyResetTimer);
      copyResetTimer = setTimeout(() => { if (el.copy) el.copy.innerHTML = icons.copy; }, 1400);
    }
    announce(`Copied definition for ${view.payload.word}`);
  } catch (error) {
    console.error('Gloss could not copy the definition:', error);
    toast('Could not copy definition to clipboard.');
  }
}

function wireDrag() {
  if (!el.head) return;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let origLeft = 0;
  let origTop = 0;

  el.head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = el.root.getBoundingClientRect();
    origLeft = rect.left;
    origTop = rect.top;
    el.head.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  el.head.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      if (!view.pinned) togglePin();
    }
    const pw = el.root.offsetWidth || 360;
    const ph = el.root.offsetHeight || 200;
    const left = Math.max(MARGIN, Math.min(window.innerWidth - pw - MARGIN, origLeft + dx));
    const top = Math.max(MARGIN, Math.min(window.innerHeight - ph - MARGIN, origTop + dy));
    el.root.style.left = `${Math.round(left)}px`;
    el.root.style.top = `${Math.round(top)}px`;
  });

  const stop = () => { dragging = false; };
  el.head.addEventListener('pointerup', stop);
  el.head.addEventListener('pointercancel', stop);
}

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

/** Shortest the popup is ever squeezed to before it is allowed to overlap. */
const MIN_HEIGHT = 150;

/**
 * Place the popup next to the selection without covering it.
 *
 * Below the word if the whole popup fits there, otherwise above. In a short
 * window neither may fit — and simply clamping to the top edge, as before,
 * dropped the popup squarely over the line being read. So the fallbacks are:
 * beside the word if there is room to its right or left, and failing that the
 * roomier of above/below with the popup's height capped to the space there
 * (its body scrolls).
 */
function position(anchorRect) {
  if (view.pinned) return; // pinned popups stay put
  if (anchorRect) view.anchorRect = anchorRect;
  const rect = view.anchorRect;
  if (!rect) return;

  el.root.style.maxHeight = ''; // measure at the stylesheet's natural cap
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pw = el.root.offsetWidth || 360;
  let ph = el.root.offsetHeight || 200;

  const below = vh - MARGIN - (rect.bottom + GAP);
  const above = rect.top - GAP - MARGIN;
  let top;
  let left = rect.left;

  if (ph <= below) {
    top = rect.bottom + GAP;
  } else if (ph <= above) {
    top = rect.top - ph - GAP;
  } else {
    const rightRoom = vw - MARGIN - (rect.right + GAP);
    const leftRoom = rect.left - GAP - MARGIN;
    if (pw <= rightRoom || pw <= leftRoom) {
      left = pw <= rightRoom ? rect.right + GAP : rect.left - GAP - pw;
      top = rect.top;
    } else {
      const room = Math.max(below, above);
      if (room >= MIN_HEIGHT) {
        el.root.style.maxHeight = `${Math.floor(room)}px`;
        ph = Math.min(ph, Math.floor(room));
      }
      top = below >= above ? rect.bottom + GAP : rect.top - ph - GAP;
    }
  }

  top = Math.max(MARGIN, Math.min(top, vh - ph - MARGIN));
  left = Math.max(MARGIN, Math.min(left, vw - pw - MARGIN));
  el.root.style.top = `${Math.round(top)}px`;
  el.root.style.left = `${Math.round(left)}px`;
}

/**
 * Pull the popup back inside the window after the window shrinks. A pinned
 * or dragged popup keeps the spot the reader chose as far as that is still
 * on screen; an unpinned one is simply re-anchored to its word.
 */
export function keepInView() {
  if (!isShown(el.root)) return;
  if (!view.pinned) { position(null); return; }
  const rect = el.root.getBoundingClientRect();
  const left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - rect.width - MARGIN));
  const top = Math.max(MARGIN, Math.min(rect.top, window.innerHeight - rect.height - MARGIN));
  el.root.style.left = `${Math.round(left)}px`;
  el.root.style.top = `${Math.round(top)}px`;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/**
 * payload = {
 *   word, phase: 'loading' | 'done',
 *   sources: [
 *     {kind:'local', dictName, keyText, html} |
 *     {kind:'wiktionary', word, sections, url} |
 *     {kind:'wiki', title, extract, url, lang}
 *   ],
 *   wiktState: 'loading'|'hit'|'miss'|'offline'|'error'|'skipped',
 *   wikiState: 'loading'|'hit'|'miss'|'offline'|'error'|'skipped',
 *   webSearch: boolean,   // show the "Search the web" escape hatch
 * }
 */
export function render(payload, anchorRect) {
  const wasOpen = isShown(el.root);
  view.payload = payload;
  if (!wasOpen) { view.history = []; view.activeTab = 0; }
  if (view.activeTab >= Math.max(1, payload.sources.length)) view.activeTab = 0;

  el.word.textContent = payload.word;
  el.back.hidden = view.history.length === 0;
  syncSaveState();
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
  syncSaveState();
  renderTabs();
  renderBody();
}

/** A source's name as plain text. Escape it at the point of use, once. */
function sourceLabel(source) {
  if (source.kind === 'wiki') return `Wikipedia (${source.lang})`;
  if (source.kind === 'wiktionary') return 'Wiktionary';
  return source.dictName || 'Dictionary';
}

/** Google's "define" query is the one users reach for; keep that intent. */
function webSearchUrl(word) {
  return `https://www.google.com/search?q=${encodeURIComponent(`define ${word}`)}`;
}

/**
 * Wiktionary comes back as language sections, each with a part of speech and
 * numbered senses. Definition bodies are wiki HTML and go through the same
 * sanitizer as any dictionary.
 */
function renderWiktionary(source) {
  const sections = Array.isArray(source.sections) ? source.sections : [];
  const body = sections.map((section) => {
    const langAttr = section.lang ? ` lang="${esc(section.lang)}"` : '';
    const heading = [section.language, section.partOfSpeech].filter(Boolean);
    const senses = (section.senses || []).map((sense) => {
      const examples = (sense.examples || [])
        .map(ex => `<blockquote class="wikt-example">${sanitizeDefinition(ex)}</blockquote>`)
        .join('');
      return `<li class="wikt-sense"><div class="wikt-def">${sanitizeDefinition(sense.definition)}</div>${examples}</li>`;
    }).join('');
    return `
      <section class="wikt-section"${langAttr}>
        ${heading.length ? `<h4 class="wikt-heading">
          ${section.language ? `<span class="wikt-lang">${esc(section.language)}</span>` : ''}
          ${section.partOfSpeech ? `<span class="wikt-pos">${esc(section.partOfSpeech)}</span>` : ''}
        </h4>` : ''}
        <ol class="wikt-senses">${senses}</ol>
      </section>`;
  }).join('');

  return `
    <span class="source-badge source-badge--wikt">${icons.book}Wiktionary</span>
    <div class="wikt-body">${body}</div>
    <a class="def-link def-link--external popup-more" role="link" tabindex="0"
       data-external="${esc(source.url)}">Read more on Wiktionary ${icons.external}</a>`;
}

/** One line covering both online tiers, used when nothing local matched. */
function onlineNote(wiktState, wikiState) {
  const states = [wiktState, wikiState];
  if (states.includes('loading')) {
    const which = wiktState === 'loading' ? 'Wiktionary' : 'Wikipedia';
    return `<div class="popup-state">${icons.spinner}<span>Checking ${which}…</span></div>`;
  }
  if (states.includes('offline')) {
    return `<div class="popup-state popup-state--muted">${icons.offline}<span>No local match — and online sources are unreachable offline.</span></div>`;
  }
  if (states.includes('error')) {
    return `<div class="popup-state popup-state--muted"><span>No local match — the online lookup failed.</span></div>`;
  }
  return `<div class="popup-state popup-state--muted"><span>No definition found.</span></div>`;
}

function renderTabs() {
  const { sources } = view.payload;
  if (sources.length <= 1) { hide(el.tabs); return; }
  show(el.tabs);
  el.tabs.innerHTML = sources.map((s, i) =>
    `<button class="popup-tab${i === view.activeTab ? ' popup-tab--active' : ''}"
             role="tab" aria-selected="${i === view.activeTab}" data-tab="${i}"
             title="${esc(sourceLabel(s))}${i < 9 ? ` (${i + 1})` : ''}">${esc(sourceLabel(s))}</button>`
  ).join('');
}

function renderBody() {
  const { phase, sources, wikiState, wiktState = 'skipped', localErrors = [] } = view.payload;
  const parts = [];
  const localFailure = localErrors.length > 0
    ? `${localErrors.slice(0, 2).join(', ')} ${localErrors.length === 1 ? 'is' : 'are'} unavailable. Reload ${localErrors.length === 1 ? 'it' : 'them'} in Preferences.`
    : '';

  if (phase === 'loading') {
    parts.push(`<div class="popup-state">${icons.spinner}<span>Looking up…</span></div>`);
  } else if (sources.length === 0) {
    parts.push(onlineNote(wiktState, wikiState));
  } else {
    const source = sources[Math.min(view.activeTab, sources.length - 1)];
    if (source.kind === 'wiktionary') {
      parts.push(renderWiktionary(source));
    } else if (source.kind === 'wiki') {
      parts.push(`
        <span class="source-badge source-badge--wiki">${icons.globe}Wikipedia</span>
        <p class="popup-extract">${esc(source.extract)}</p>
        <a class="def-link def-link--external popup-more" role="link" tabindex="0"
           data-external="${esc(source.url)}">Read more on Wikipedia ${icons.external}</a>`);
    } else {
      const badgeIcon = source.dictKind === 'glossary' ? icons.bookmark : icons.book;
      parts.push(`<span class="source-badge">${badgeIcon}${esc(source.dictName)}</span>`);
      if (source.keyText && source.keyText !== view.payload.word) {
        parts.push(`<div class="popup-matched">${esc(source.keyText)}</div>`);
      }
      const lang = source.language ? ` lang="${esc(source.language)}"` : '';
      parts.push(`<div class="popup-definition"${lang}>${sanitizeDefinition(source.html)}</div>`);
      // Glossaries may carry the sentence the word was found in.
      if (source.example) {
        parts.push(`<blockquote class="popup-example"${lang}>${esc(source.example)}</blockquote>`);
      }
      if (source.dictKind === 'glossary' && (source.page || source.count)) {
        const details = [];
        if (source.page) details.push(`first seen on page ${source.page}`);
        if (source.count) details.push(`${source.count} ${source.count === 1 ? 'occurrence' : 'occurrences'}`);
        parts.push(`<div class="popup-entry-meta">${esc(details.join(' · '))}</div>`);
      }
    }
    if (wiktState === 'loading' || wikiState === 'loading') {
      const which = wiktState === 'loading' ? 'Wiktionary' : 'Wikipedia';
      parts.push(`<div class="popup-state popup-state--footer">${icons.spinner}<span>Checking ${which}…</span></div>`);
    }
  }

  if (localFailure) {
    parts.push(`<div class="popup-state popup-state--footer popup-state--warning" role="status"><span>${esc(localFailure)}</span></div>`);
  }

  // Last resort, and the only place Gloss hands a word to a search engine:
  // an explicit, user-initiated link that opens in the default browser.
  if (view.payload.webSearch && phase !== 'loading') {
    parts.push(`
      <div class="popup-websearch">
        <a class="def-link def-link--external" role="link" tabindex="0"
           data-external="${esc(webSearchUrl(view.payload.word))}"
           title="Opens in your browser">${icons.search}Search the web</a>
      </div>`);
  }

  el.body.innerHTML = parts.join('');
  el.body.scrollTop = 0;
  // Switching to a longer source can push a pinned popup past the window edge.
  if (view.pinned) keepInView();
}

/** Announce results for screen readers (called once per completed lookup). */
export function announceResult(payload) {
  const n = payload.sources.length;
  if (n === 0 && payload.localErrors?.length) {
    announce(`Local dictionary unavailable for ${payload.word}`);
  } else if (n === 0) announce(`No definition found for ${payload.word}`);
  else announce(`Definition for ${payload.word}: ${n} ${n === 1 ? 'source' : 'sources'}`);
}
