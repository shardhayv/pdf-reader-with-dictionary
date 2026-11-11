/**
 * viewer.js — PDF document lifecycle and the virtualized page renderer.
 *
 * Responsibilities: open/close documents (incl. password flow), bounded
 * lazy rendering with cancellation, zoom (fit-width / fit-page / custom)
 * with anchored scrolling, page-text caching for search & lookup quality,
 * and clean teardown so stale async work can never touch a newer document.
 */

import * as pdfjsLib from '../../node_modules/pdfjs-dist/build/pdf.mjs';
import { refs, debounce, prefersReducedMotion } from './dom.js';
import { assessTextQuality, graphemes } from './text.js';

const PDFJS_BASE = new URL('../../node_modules/pdfjs-dist/', import.meta.url);
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('build/pdf.worker.mjs', PDFJS_BASE).href;

export const RENDER_BUFFER = 2;       // pages beyond the viewport to pre-render
export const DESTROY_DISTANCE = 5;    // rendered pages farther than this are recycled
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;
export const ZOOM_STEP = 1.1;
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024; // per-page device-pixel budget
const SPREAD_COLUMN_GAP = 16;               // must match .pages--spread column-gap
const RERENDER_DEBOUNCE_MS = 140;
// A page becomes "the current page" once this much of it is on screen…
const CURRENT_PAGE_MIN_FRACTION = 0.08;
// …or, for a page far taller than the window, once it fills this much of it.
const CURRENT_PAGE_MIN_VIEWPORT = 0.33;
const QUALITY_SAMPLE_PAGES = 4;

const state = {
  doc: null,
  loadingTask: null,
  pendingLoadingTask: null,
  generation: 0,     // bumped whenever the mounted document changes
  openSequence: 0,   // bumped per open attempt, including ones that fail
  total: 0,
  current: 1,
  zoomMode: 'fit-width',
  zoomScale: 1,
  rotation: 0,      // 0 | 90 | 180 | 270 user rotation offset
  spreadMode: 'single', // 'single' | 'two-page'
  bookmarks: new Set(), // 1-based bookmarked page numbers for current document
  rawBaseWidth: 612,
  rawBaseHeight: 792,
  baseWidth: 612,   // page 1 at scale 1 (US Letter fallback)
  baseHeight: 792,
  rawPageDims: new Map(),  // page -> {w, h} at scale 1, rotation 0
  pageDims: new Map(),     // page -> {w, h} at scale 1, current rotation
  renderTasks: new Map(),  // page -> RenderTask
  textCache: new Map(),    // page -> { text, items: [{start, end}] }
  historyBack: [],         // [{ page, offset }] — see readingPosition()
  historyForward: [],      // [{ page, offset }]
  lazyObserver: null,
  scrollFrame: 0,
};

const listeners = new Map();
export function on(event, cb) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(cb);
  return () => listeners.get(event).delete(cb);
}
function emit(event, payload) {
  for (const cb of listeners.get(event) || []) cb(payload);
}

// ── Introspection ─────────────────────────────────────────────────────────────

export const hasDocument = () => !!state.doc;
/** Identity of the mounted document; used to discard work from an older one. */
export const documentGeneration = () => state.generation;
/** Stable PDF identifier used to activate a glossary even if a book is moved. */
export const documentFingerprint = () => state.doc?.fingerprints?.[0] || '';
export const pageCount = () => state.total;
export const currentPage = () => state.current;
export const zoomMode = () => state.zoomMode;
export const zoomScale = () => state.zoomScale;
export const rotation = () => state.rotation;
export const spreadMode = () => state.spreadMode;
export const bookmarks = () => [...state.bookmarks].sort((a, b) => a - b);
export const isBookmarked = (n = state.current) => state.bookmarks.has(n);
export const canGoBack = () => state.historyBack.length > 0;
export const canGoForward = () => state.historyForward.length > 0;

// ── Geometry ──────────────────────────────────────────────────────────────────

function rotatedDims({ w, h }, rot = state.rotation) {
  return (rot === 90 || rot === 270) ? { w: h, h: w } : { w, h };
}

function dimsFor(n) {
  const raw = state.rawPageDims.get(n);
  if (raw) return rotatedDims(raw);
  return state.pageDims.get(n) || { w: state.baseWidth, h: state.baseHeight };
}

/**
 * Space around the pages, read from the stylesheet rather than duplicated
 * here: the gutters narrow on small windows, and a constant that drifted
 * from the CSS would leave "fit width" a few pixels too wide.
 */
function pageGutters() {
  const style = getComputedStyle(refs.pages());
  return {
    horizontal: (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0),
    vertical: (parseFloat(style.paddingTop) || 0) + 28,
  };
}

function computeFitScale(mode) {
  const container = refs.container();
  const gutters = pageGutters();
  const availW = Math.max(120, container.clientWidth - gutters.horizontal);
  const cols = state.spreadMode === 'two-page' && state.total > 1 ? 2 : 1;
  const colGap = cols === 2 ? SPREAD_COLUMN_GAP : 0;
  const widthScale = Math.max(60, availW - colGap) / (state.baseWidth * cols);
  if (mode === 'fit-page') {
    const availH = Math.max(120, container.clientHeight - gutters.vertical);
    return Math.min(widthScale, availH / state.baseHeight);
  }
  return widthScale;
}

function sizeWrapper(wrapper, n) {
  const { w, h } = dimsFor(n);
  wrapper.style.width = `${Math.floor(w * state.zoomScale)}px`;
  wrapper.style.height = `${Math.floor(h * state.zoomScale)}px`;
}

// ── Placeholders & observers ──────────────────────────────────────────────────

// ── Link annotations ──────────────────────────────────────────────────────────

/**
 * Build the clickable-link overlay for a page.
 *
 * Only Link annotations are honoured — widgets, forms and popups are
 * deliberately not rendered. The layer takes no pointer events at all: text
 * selection is Gloss's primary gesture and must never be intercepted by an
 * invisible box. Clicks are resolved by hit-testing in links.js instead, and
 * the anchors carry no href, exactly like sanitized dictionary links, so
 * nothing here can navigate the app frame.
 */
function buildLinkLayer(annotations, viewport) {
  const links = [];
  for (const a of annotations) {
    if (a?.subtype !== 'Link') continue;
    // pdf.js resolves and filters `url`; unsafeUrl is never used.
    const url = typeof a.url === 'string' ? a.url : '';
    const external = /^https?:\/\//i.test(url) ? url : '';
    if (!external && !a.dest) continue;
    if (!Array.isArray(a.rect) || a.rect.length !== 4) continue;

    const [x1, y1] = viewport.convertToViewportPoint(a.rect[0], a.rect[1]);
    const [x2, y2] = viewport.convertToViewportPoint(a.rect[2], a.rect[3]);
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const width = Math.abs(x2 - x1);
    const height = Math.abs(y2 - y1);
    if (width < 1 || height < 1) continue;

    const el = document.createElement('a');
    el.className = 'pdf-link';
    el.setAttribute('role', 'link');
    el.setAttribute('tabindex', '0');
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    if (external) {
      el.dataset.external = external;
      el.title = external;
      el.setAttribute('aria-label', `Link: ${external}`);
    } else {
      el.dataset.dest = '1';
      el._dest = a.dest;
      el.setAttribute('aria-label', 'Link to another place in this document');
    }
    links.push(el);
  }
  if (links.length === 0) return null;

  const layer = document.createElement('div');
  layer.className = 'pdf-link-layer';
  layer.append(...links);
  return layer;
}

/** Every link element on a rendered page, in document order. */
export function linkElementsFor(n) {
  const wrapper = wrapperFor(n);
  if (!wrapper || wrapper.dataset.rendered !== 'true') return [];
  return [...wrapper.querySelectorAll('.pdf-link')];
}

function makePlaceholder(n) {
  const el = document.createElement('div');
  el.className = 'page-placeholder';
  el.textContent = String(n);
  return el;
}

function showPageRenderFailure(wrapper, n) {
  const failure = document.createElement('div');
  failure.className = 'page-render-error';
  failure.setAttribute('role', 'status');
  const message = document.createElement('span');
  message.textContent = `Page ${n} could not be rendered.`;
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'btn page-render-retry';
  retry.textContent = 'Retry page';
  retry.addEventListener('click', () => {
    wrapper.replaceChildren(makePlaceholder(n));
    wrapper.dataset.rendered = 'false';
    renderPage(n);
  });
  failure.append(message, retry);
  wrapper.replaceChildren(failure);
}

function buildPlaceholders() {
  const pages = refs.pages();
  const frag = document.createDocumentFragment();
  for (let n = 1; n <= state.total; n++) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page-wrapper';
    wrapper.dataset.pageNumber = String(n);
    wrapper.dataset.rendered = 'false';
    sizeWrapper(wrapper, n);
    wrapper.appendChild(makePlaceholder(n));
    frag.appendChild(wrapper);
  }
  pages.replaceChildren(frag);
}

/**
 * Index of the first page whose bottom edge lies below content offset `y`.
 * Wrappers are laid out top to bottom, so a binary search finds it without
 * touching more than a dozen of them even in a thousand-page book.
 */
function firstPageEndingAfter(y) {
  const pages = refs.pages().children;
  let lo = 0;
  let hi = pages.length - 1;
  let answer = Math.max(0, pages.length - 1);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const wrapper = pages[mid];
    if (wrapper.offsetTop + wrapper.offsetHeight > y) {
      answer = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return answer;
}

/**
 * Recompute the current page from the scroll position.
 *
 * The current page is the first one with a meaningful slice on screen. This
 * is derived from geometry rather than an IntersectionObserver threshold
 * because a threshold is a fraction of the *page*: zoom far enough into a
 * large sheet and no amount of scrolling ever shows 8% of it, so the page
 * number froze.
 */
function updateCurrentPage() {
  if (!state.doc) return;
  const container = refs.container();
  const pages = refs.pages().children;
  if (pages.length === 0) return;

  const top = container.scrollTop;
  const viewHeight = container.clientHeight;
  let index = firstPageEndingAfter(top);
  for (; index < pages.length - 1; index++) {
    const wrapper = pages[index];
    const visible = Math.min(wrapper.offsetTop + wrapper.offsetHeight, top + viewHeight) -
      Math.max(wrapper.offsetTop, top);
    const needed = Math.min(wrapper.offsetHeight * CURRENT_PAGE_MIN_FRACTION,
      viewHeight * CURRENT_PAGE_MIN_VIEWPORT);
    if (visible >= needed) break;
  }
  const next = index + 1;
  if (next !== state.current) {
    state.current = next;
    emit('pagechanged', next);
  }
}

function onContainerScroll() {
  if (state.scrollFrame) return;
  state.scrollFrame = requestAnimationFrame(() => {
    state.scrollFrame = 0;
    updateCurrentPage();
  });
}

let scrollTrackingAttached = false;

function setupObservers() {
  const container = refs.container();

  if (!scrollTrackingAttached) {
    scrollTrackingAttached = true;
    container.addEventListener('scroll', onContainerScroll, { passive: true });
  }

  state.lazyObserver = new IntersectionObserver((entries) => {
    let nearest = null;
    const buffer = state.spreadMode === 'two-page' ? RENDER_BUFFER * 2 : RENDER_BUFFER;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const n = Number(entry.target.dataset.pageNumber);
      nearest = nearest === null ? n : Math.min(nearest, n);
      for (let i = n - buffer; i <= n + buffer; i++) {
        if (i >= 1 && i <= state.total) renderPage(i);
      }
    }
    if (nearest !== null) destroyFarPages(nearest);
  }, { root: container, rootMargin: '600px 0px 600px 0px', threshold: 0 });

  for (const wrapper of refs.pages().children) {
    state.lazyObserver.observe(wrapper);
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function wrapperFor(n) {
  return refs.pages().querySelector(`.pdf-page-wrapper[data-page-number="${n}"]`);
}

export function renderPage(n) {
  const wrapper = wrapperFor(n);
  if (!wrapper) return Promise.resolve();
  if (wrapper.dataset.rendered === 'true') {
    if (wrapper.dataset.stale === '1') return rerenderPage(n);
    return wrapper._renderPromise || Promise.resolve();
  }
  wrapper.dataset.rendered = 'true';
  delete wrapper.dataset.stale;
  const gen = state.generation;

  wrapper._renderPromise = (async () => {
    let task = null;
    try {
      const page = await state.doc.getPage(n);
      if (gen !== state.generation) return;

      if (!state.rawPageDims.has(n)) {
        const vp0 = page.getViewport({ scale: 1, rotation: page.rotate || 0 });
        state.rawPageDims.set(n, { w: vp0.width, h: vp0.height });
      }
      const effectiveRotation = ((page.rotate || 0) + state.rotation) % 360;
      state.pageDims.set(n, rotatedDims(state.rawPageDims.get(n)));
      const viewport = page.getViewport({ scale: state.zoomScale, rotation: effectiveRotation });
      sizeWrapper(wrapper, n);

      const dpr = window.devicePixelRatio || 1;
      // The pixel budget is a hard ceiling, not a preference: a large-format
      // page (a plan or poster) at high zoom must not be allowed to request
      // a bitmap the GPU will refuse to allocate.
      const budget = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, viewport.width * viewport.height));
      const ratio = Math.min(dpr, budget);

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.scale(ratio, ratio);

      task = page.render({ canvas: null, canvasContext: ctx, viewport });
      state.renderTasks.set(n, task);
      await task.promise;
      state.renderTasks.delete(n);
      if (gen !== state.generation || wrapper.dataset.rendered !== 'true') return;

      // Make the painted page visible immediately. Text extraction can be
      // slower (or fail independently) and must never hold the page hostage.
      wrapper.dataset.renderedScale = String(state.zoomScale);
      wrapper.replaceChildren(canvas);

      // Painting the page and extracting selectable text are independent.
      // If a malformed ToUnicode map breaks the text layer, keep the visible
      // page instead of replacing successful rendering with a blank error.
      let textLayerDiv = null;
      try {
        const textContent = await page.getTextContent();
        if (gen !== state.generation) return;
        cacheText(n, textContent);
        textLayerDiv = document.createElement('div');
        textLayerDiv.className = 'pdf-text-layer';
        textLayerDiv.style.setProperty('--scale-factor', String(viewport.scale));
        const textLayer = new pdfjsLib.TextLayer({
          textContentSource: textContent,
          container: textLayerDiv,
          viewport,
        });
        await textLayer.render();
        wrapper._textDivs = textLayer.textDivs;
      } catch (textError) {
        console.warn(`gloss: selectable text unavailable on page ${n}:`, textError?.message || textError);
        textLayerDiv = null;
        wrapper._textDivs = null;
      }
      // Link annotations are a third independent concern: a page with broken
      // annotations still paints and still selects.
      let linkLayerDiv = null;
      try {
        const annotations = await page.getAnnotations({ intent: 'display' });
        if (gen !== state.generation) return;
        linkLayerDiv = buildLinkLayer(annotations, viewport);
      } catch (annotationError) {
        console.warn(`gloss: links unavailable on page ${n}:`, annotationError?.message || annotationError);
        linkLayerDiv = null;
      }
      if (gen !== state.generation || wrapper.dataset.rendered !== 'true') return;

      wrapper.replaceChildren(...[canvas, textLayerDiv, linkLayerDiv].filter(Boolean));
      emit('pagerendered', n);
    } catch (err) {
      state.renderTasks.delete(n);
      if (gen === state.generation && wrapper.isConnected) {
        wrapper.dataset.rendered = 'false';
        if (!err || err.name !== 'RenderingCancelledException') {
          console.warn(`gloss: page ${n} render failed:`, err?.message);
          showPageRenderFailure(wrapper, n);
        }
      }
    }
  })();
  return wrapper._renderPromise;
}

function destroyPage(wrapper) {
  const n = Number(wrapper.dataset.pageNumber);
  const task = state.renderTasks.get(n);
  if (task) { task.cancel(); state.renderTasks.delete(n); }
  wrapper.replaceChildren(makePlaceholder(n));
  wrapper.dataset.rendered = 'false';
  delete wrapper.dataset.stale;
  delete wrapper.dataset.renderedScale;
  delete wrapper._textDivs;
  delete wrapper._renderPromise;
  delete wrapper.dataset.renderFailures;
  emit('pagedestroyed', n);
}

function rerenderPage(n) {
  const wrapper = wrapperFor(n);
  if (!wrapper) return Promise.resolve();
  destroyPage(wrapper);
  sizeWrapper(wrapper, n);
  return renderPage(n);
}

function destroyFarPages(nearPage) {
  const maxDist = state.spreadMode === 'two-page' ? DESTROY_DISTANCE * 2 : DESTROY_DISTANCE;
  for (const wrapper of refs.pages().querySelectorAll('.pdf-page-wrapper[data-rendered="true"]')) {
    const n = Number(wrapper.dataset.pageNumber);
    if (Math.abs(n - nearPage) > maxDist) destroyPage(wrapper);
  }
}

/** Rendered page count — exposed for tests asserting bounded memory. */
export function renderedPageCount() {
  return refs.pages().querySelectorAll('.pdf-page-wrapper[data-rendered="true"]').length;
}

/** Live text divs for a rendered page (search highlighting). */
export function textDivsFor(n) {
  const wrapper = wrapperFor(n);
  return wrapper && wrapper.dataset.rendered === 'true' ? (wrapper._textDivs || null) : null;
}

// ── Page text cache (search, quality assessment) ──────────────────────────────

function cacheText(n, textContent) {
  if (state.textCache.has(n)) return;
  let text = '';
  const items = [];
  let previous = null;
  for (const item of textContent.items) {
    const separator = searchItemBoundary(previous, item);
    if (separator && text && !/\s$/.test(text)) text += separator;
    const start = text.length;
    text += item.str;
    items.push({ start, end: text.length });
    previous = item;
  }
  state.textCache.set(n, { text, items });
}

function textEdgeWord(value, side) {
  const pattern = side === 'end'
    ? /([\p{L}\p{M}\p{Cf}]+)$/u
    : /^([\p{L}\p{M}\p{Cf}]+)/u;
  return String(value || '').match(pattern)?.[1] || '';
}

function isRecoveredDevanagariBoundary(previous, item) {
  const left = textEdgeWord(previous.str, 'end');
  const right = textEdgeWord(item.str, 'start');
  if (!left || !right || !/\p{Script=Devanagari}/u.test(left) || !/\p{Script=Devanagari}/u.test(right)) {
    return false;
  }
  const beforeLeft = previous.str.slice(0, previous.str.length - left.length);
  // A short fragment attached after punctuation is the pdf.js split exposed
  // by the fixture: "… ।प्र" + "ज्ञा …". Join this conservative case while
  // keeping ordinary line/column boundaries searchable as separate words.
  return /[\p{P}\p{S}]\s*$/u.test(beforeLeft) && graphemes(left).length <= 2;
}

function searchItemBoundary(previous, item) {
  if (!previous || !item || typeof item.str !== 'string') return '';
  if (/\s$/.test(previous.str) || /^\s/.test(item.str)) return '';
  const previousTransform = Array.isArray(previous.transform) ? previous.transform : [];
  const transform = Array.isArray(item.transform) ? item.transform : [];
  const sameLine = previousTransform.length >= 6 && transform.length >= 6 &&
    Math.abs(transform[5] - previousTransform[5]) < 2;
  const previousWidth = Number.isFinite(previous.width) ? previous.width : 0;
  const gap = sameLine ? transform[4] - (previousTransform[4] + previousWidth) : Infinity;
  const scale = Math.max(1, Math.min(previous.height || 10, item.height || 10));
  const hardBoundary = previous.hasEOL || !sameLine || gap > Math.max(0.8, scale * 0.08);
  if (!hardBoundary || isRecoveredDevanagariBoundary(previous, item)) return '';
  return ' ';
}

/** Synchronous access to already-extracted page text (or null). */
export function getPageTextCached(n) {
  return state.textCache.get(n) || null;
}

/** Extract (and cache) the text of a page without rendering it. */
export async function getPageText(n) {
  if (state.textCache.has(n)) return state.textCache.get(n);
  const gen = state.generation;
  const page = await state.doc.getPage(n);
  const textContent = await page.getTextContent();
  if (gen !== state.generation) return { text: '', items: [] };
  cacheText(n, textContent);
  return state.textCache.get(n);
}

async function assessDocumentText() {
  const gen = state.generation;
  const sample = [];
  const pagesToSample = Math.min(QUALITY_SAMPLE_PAGES, state.total);
  for (let n = 1; n <= pagesToSample; n++) {
    const { text } = await getPageText(n);
    if (gen !== state.generation) return;
    sample.push(text);
  }
  if (state.total > QUALITY_SAMPLE_PAGES + 1) {
    const mid = Math.ceil(state.total / 2);
    const { text } = await getPageText(mid);
    if (gen !== state.generation) return;
    sample.push(text);
  }
  emit('textquality', assessTextQuality(sample.join('\n')));
}

// ── Zoom ──────────────────────────────────────────────────────────────────────

const rerenderVisibleDebounced = debounce(() => {
  const container = refs.container();
  const top = container.scrollTop;
  const bottom = top + container.clientHeight;
  for (const wrapper of refs.pages().children) {
    if (wrapper.dataset.stale !== '1') continue;
    const yTop = wrapper.offsetTop;
    const yBottom = yTop + wrapper.offsetHeight;
    const margin = container.clientHeight; // one screen of slack
    if (yBottom >= top - margin && yTop <= bottom + margin) {
      rerenderPage(Number(wrapper.dataset.pageNumber));
    }
  }
}, RERENDER_DEBOUNCE_MS);

/**
 * Remember what sits under a point of the viewport, as a position *within a
 * page* — so it can be put back after the pages change size.
 *
 * Scaling the scroll offset by the zoom ratio looks equivalent and is not:
 * the gaps between pages and the padding around them do not scale. Two
 * hundred pages into a book that fixed space adds up to several hundred
 * pixels, so every zoom step — and every window resize in a fit mode —
 * visibly threw the reader off their place.
 *
 * @param {{x:number, y:number}|'top'|null} anchor  client coordinates, the
 *        top edge of the viewport, or (null) its centre.
 */
function captureAnchor(anchor) {
  const container = refs.container();
  const pages = refs.pages().children;
  const rect = container.getBoundingClientRect();
  let offsetX = container.clientWidth / 2;
  let offsetY = container.clientHeight / 2;
  if (anchor === 'top') {
    offsetY = 0;
  } else if (anchor && typeof anchor === 'object') {
    offsetX = anchor.x - rect.left;
    offsetY = anchor.y - rect.top;
  }
  if (pages.length === 0) return null;

  const contentX = container.scrollLeft + offsetX;
  const contentY = container.scrollTop + offsetY;
  let wrapper = pages[firstPageEndingAfter(contentY)];
  // In a two-page spread both pages of a row end at the same height; take
  // the one the pointer is actually over.
  const sibling = wrapper.nextElementSibling;
  if (sibling && sibling.offsetTop === wrapper.offsetTop && contentX >= sibling.offsetLeft) {
    wrapper = sibling;
  }
  // Inside the page the position is a fraction of the page, which scales
  // with it. In the gap beside a page it is a pixel distance from the nearest
  // edge, which does not — otherwise a resize at the very top of a document
  // would "scale" the 12px of padding above page 1 and nudge the scroll.
  const along = (distance, size) => {
    if (size <= 0 || distance < 0) return { fraction: 0, pixels: Math.min(0, distance) };
    if (distance > size) return { fraction: 1, pixels: distance - size };
    return { fraction: distance / size, pixels: 0 };
  };
  return {
    wrapper,
    offsetX,
    offsetY,
    x: along(contentX - wrapper.offsetLeft, wrapper.offsetWidth),
    y: along(contentY - wrapper.offsetTop, wrapper.offsetHeight),
  };
}

/** Scroll so the point captured by captureAnchor() is back where it was. */
function restoreAnchor(captured) {
  if (!captured || !captured.wrapper.isConnected) return;
  const container = refs.container();
  const { wrapper, offsetX, offsetY, x, y } = captured;
  container.scrollTop = wrapper.offsetTop + y.fraction * wrapper.offsetHeight + y.pixels - offsetY;
  container.scrollLeft = wrapper.offsetLeft + x.fraction * wrapper.offsetWidth + x.pixels - offsetX;
}

/**
 * Set zoom. `anchor` is the point that stays put: wheel zoom passes the
 * cursor, a window resize passes 'top', and the default is the centre.
 */
export function setZoom(mode, explicitScale = null, anchor = null) {
  if (!state.doc) return;

  let newScale;
  if (mode === 'custom') {
    newScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, explicitScale ?? state.zoomScale));
  } else {
    newScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, computeFitScale(mode)));
  }
  const ratio = newScale / state.zoomScale;
  const modeChanged = mode !== state.zoomMode;
  if (!modeChanged && Math.abs(ratio - 1) < 0.0005) return;

  const captured = captureAnchor(anchor);
  state.zoomMode = mode;
  state.zoomScale = newScale;

  for (const wrapper of refs.pages().children) {
    const n = Number(wrapper.dataset.pageNumber);
    sizeWrapper(wrapper, n);
    if (wrapper.dataset.rendered === 'true') {
      const renderedScale = Number(wrapper.dataset.renderedScale) || newScale;
      const factor = newScale / renderedScale;
      const canvas = wrapper.querySelector('canvas');
      const { w, h } = dimsFor(n);
      if (canvas) {
        canvas.style.width = `${Math.floor(w * newScale)}px`;
        canvas.style.height = `${Math.floor(h * newScale)}px`;
      }
      // The text and link layers are laid out for the scale they were built
      // at; scale them together until the page is re-rendered sharply.
      for (const layer of wrapper.querySelectorAll('.pdf-text-layer, .pdf-link-layer')) {
        layer.style.transform = factor === 1 ? '' : `scale(${factor})`;
      }
      if (Math.abs(factor - 1) > 0.0005) wrapper.dataset.stale = '1';
    }
  }

  restoreAnchor(captured);
  updateCurrentPage();

  emit('zoomchanged', { mode: state.zoomMode, scale: state.zoomScale });
  rerenderVisibleDebounced();
}

export function zoomIn(anchor) { setZoom('custom', state.zoomScale * ZOOM_STEP, anchor); }
export function zoomOut(anchor) { setZoom('custom', state.zoomScale / ZOOM_STEP, anchor); }

/** Rotate all pages by a multiple of 90 degrees (e.g. +90 or -90). */
export function setRotation(degrees) {
  if (!state.doc) return;
  const normalized = (((Math.round(degrees / 90) * 90) % 360) + 360) % 360;
  if (normalized === state.rotation) return;
  const pageBefore = state.current;
  state.rotation = normalized;
  const base = rotatedDims({ w: state.rawBaseWidth, h: state.rawBaseHeight });
  state.baseWidth = base.w;
  state.baseHeight = base.h;
  for (const [n, raw] of state.rawPageDims.entries()) {
    state.pageDims.set(n, rotatedDims(raw));
  }
  if (state.zoomMode === 'fit-width' || state.zoomMode === 'fit-page') {
    state.zoomScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, computeFitScale(state.zoomMode)));
  }
  for (const wrapper of refs.pages().children) {
    const n = Number(wrapper.dataset.pageNumber);
    if (wrapper.dataset.rendered === 'true') destroyPage(wrapper);
    sizeWrapper(wrapper, n);
  }
  goToPage(pageBefore, { instant: true, recordHistory: false });
  for (let i = Math.max(1, pageBefore - 1); i <= Math.min(state.total, pageBefore + 1); i++) {
    renderPage(i);
  }
  emit('rotationchanged', state.rotation);
  emit('zoomchanged', { mode: state.zoomMode, scale: state.zoomScale });
}

export function rotateBy(deltaDegrees) {
  setRotation(state.rotation + deltaDegrees);
}

/** Switch between single-page column and two-page book spread layout. */
export function setSpreadMode(mode) {
  if (!state.doc) return;
  const next = mode === 'two-page' ? 'two-page' : 'single';
  if (next === state.spreadMode) return;
  const pageBefore = state.current;
  state.spreadMode = next;
  refs.pages().classList.toggle('pages--spread', next === 'two-page');
  if (state.zoomMode === 'fit-width' || state.zoomMode === 'fit-page') {
    state.zoomScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, computeFitScale(state.zoomMode)));
    for (const wrapper of refs.pages().children) {
      const n = Number(wrapper.dataset.pageNumber);
      if (wrapper.dataset.rendered === 'true') destroyPage(wrapper);
      sizeWrapper(wrapper, n);
    }
  }
  goToPage(pageBefore, { instant: true, recordHistory: false });
  const span = next === 'two-page' ? 2 : 1;
  for (let i = Math.max(1, pageBefore - span); i <= Math.min(state.total, pageBefore + span); i++) {
    renderPage(i);
  }
  emit('spreadchanged', state.spreadMode);
  emit('zoomchanged', { mode: state.zoomMode, scale: state.zoomScale });
}

export function toggleSpreadMode() {
  setSpreadMode(state.spreadMode === 'two-page' ? 'single' : 'two-page');
}

/** Toggle or remove a page bookmark on the current document. */
export function toggleBookmark(n = state.current) {
  if (!state.doc) return false;
  const target = Math.min(state.total, Math.max(1, Math.round(n)));
  let added = false;
  if (state.bookmarks.has(target)) {
    state.bookmarks.delete(target);
  } else {
    state.bookmarks.add(target);
    added = true;
  }
  emit('bookmarkschanged', bookmarks());
  return added;
}

export function removeBookmark(n) {
  if (!state.doc || !state.bookmarks.has(n)) return false;
  state.bookmarks.delete(n);
  emit('bookmarkschanged', bookmarks());
  return true;
}

/**
 * Recompute fit scales after the reading area changes size (window resize,
 * sidebar, find bar, read mode). The line at the top of the viewport is the
 * one the reader is on, so that is what stays put.
 */
export function handleResize() {
  if (!state.doc) return;
  if (state.zoomMode === 'fit-width' || state.zoomMode === 'fit-page') {
    setZoom(state.zoomMode, null, 'top');
  }
  updateCurrentPage();
}

// ── Navigation & Reading History ──────────────────────────────────────────────

const MAX_HISTORY = 40;

/**
 * Where the top edge of the viewport sits, as a page number and how far down
 * that page it is (a fraction of the page's height; slightly negative while
 * the gap above the page is at the top).
 *
 * This is the durable form of "where am I": unlike a pixel offset or a
 * fraction of the whole scroll height it means the same thing after the zoom
 * level, window size or sidebar changes.
 */
export function readingPosition() {
  const container = refs.container();
  const pages = refs.pages().children;
  if (!state.doc || pages.length === 0) return { page: 1, offset: 0 };
  const top = container.scrollTop;
  const index = firstPageEndingAfter(top);
  const wrapper = pages[index];
  const offset = wrapper.offsetHeight > 0 ? (top - wrapper.offsetTop) / wrapper.offsetHeight : 0;
  return { page: index + 1, offset: Math.max(-0.5, Math.min(1, offset)) };
}

/** Put the viewport back at a position reported by readingPosition(). */
function scrollToPosition(page, offset) {
  const wrapper = wrapperFor(Math.min(state.total, Math.max(1, Math.round(page))));
  if (!wrapper) return false;
  const fraction = Number.isFinite(offset) ? Math.max(-0.5, Math.min(1, offset)) : 0;
  refs.container().scrollTo({
    top: Math.max(0, wrapper.offsetTop + fraction * wrapper.offsetHeight),
    behavior: 'auto',
  });
  updateCurrentPage();
  return true;
}

function recordHistoryEntry() {
  if (!state.doc) return;
  const entry = readingPosition();
  const last = state.historyBack[state.historyBack.length - 1];
  if (last && last.page === entry.page && Math.abs(last.offset - entry.offset) < 0.03) return;
  state.historyBack.push(entry);
  if (state.historyBack.length > MAX_HISTORY) state.historyBack.shift();
  state.historyForward = [];
  emit('historychanged', { canBack: canGoBack(), canForward: canGoForward() });
}

export function goToPage(n, { instant = false, recordHistory = false } = {}) {
  const clamped = Math.min(state.total, Math.max(1, Math.round(n)));
  const wrapper = wrapperFor(clamped);
  if (!wrapper) return;
  if (recordHistory && clamped !== state.current) recordHistoryEntry();
  const container = refs.container();
  container.scrollTo({
    top: wrapper.offsetTop - 8,
    behavior: instant || prefersReducedMotion() ? 'auto' : 'smooth',
  });
  if (instant) updateCurrentPage();
}

export function goBack() {
  if (!state.doc || state.historyBack.length === 0) return false;
  state.historyForward.push(readingPosition());
  const target = state.historyBack.pop();
  scrollToPosition(target.page, target.offset);
  emit('historychanged', { canBack: canGoBack(), canForward: canGoForward() });
  return true;
}

export function goForward() {
  if (!state.doc || state.historyForward.length === 0) return false;
  state.historyBack.push(readingPosition());
  const target = state.historyForward.pop();
  scrollToPosition(target.page, target.offset);
  emit('historychanged', { canBack: canGoBack(), canForward: canGoForward() });
  return true;
}

/** Page number under a point of the window, or null outside any page. */
export function pageAtClientPoint(x, y) {
  const el = document.elementFromPoint(x, y)?.closest?.('.pdf-page-wrapper');
  return el ? Number(el.dataset.pageNumber) : null;
}

export async function ensureRendered(n) {
  await renderPage(n);
}

export function scrollFraction() {
  const container = refs.container();
  const max = container.scrollHeight - container.clientHeight;
  return max > 0 ? container.scrollTop / max : 0;
}

function restoreScrollFraction(fraction) {
  const container = refs.container();
  const max = container.scrollHeight - container.clientHeight;
  container.scrollTop = Math.max(0, Math.min(1, fraction)) * max;
}

// ── Document lifecycle ────────────────────────────────────────────────────────

export function closeDocument() {
  state.generation++;
  rerenderVisibleDebounced.cancel();
  for (const task of state.renderTasks.values()) task.cancel();
  state.renderTasks.clear();
  state.lazyObserver?.disconnect();
  state.lazyObserver = null;
  if (state.scrollFrame) cancelAnimationFrame(state.scrollFrame);
  state.scrollFrame = 0;
  state.textCache.clear();
  state.rawPageDims.clear();
  state.pageDims.clear();
  state.historyBack = [];
  state.historyForward = [];
  state.rotation = 0;
  state.spreadMode = 'single';
  state.bookmarks.clear();
  refs.pages().classList.remove('pages--spread');
  refs.pages().replaceChildren();

  if (state.pendingLoadingTask) {
    state.pendingLoadingTask.destroy().catch(() => {});
    state.pendingLoadingTask = null;
  }

  if (state.loadingTask) {
    state.loadingTask.destroy().catch(() => {});
    state.loadingTask = null;
  }
  const doc = state.doc;
  state.doc = null;
  state.total = 0;
  state.current = 1;
  if (doc) Promise.resolve(doc.destroy?.() ?? doc.cleanup?.()).catch(() => {});
  emit('documentclosed');
}

/**
 * Open a document from bytes.
 * @param {Uint8Array} data
 * @param {{name:string, path:string, restore:object|null,
 *          requestPassword:(retry:boolean)=>Promise<string|null>}} opts
 * @returns {Promise<{ok:true}|{ok:false, code:string, message:string}>}
 */
export async function openDocument(data, opts) {
  // The candidate is fully validated *before* the current document is torn
  // down: opening a damaged file must not cost the user the document they
  // are already reading.
  const openId = ++state.openSequence;

  // A CLI/file-manager open can arrive while an encrypted candidate is still
  // waiting for a password. Supersede and destroy that task rather than
  // leaving a hidden parser and unresolved prompt behind.
  if (state.pendingLoadingTask) {
    state.pendingLoadingTask.destroy().catch(() => {});
    state.pendingLoadingTask = null;
  }

  let passwordCanceled = false;
  const loadingTask = pdfjsLib.getDocument({
    data,
    cMapUrl: new URL('cmaps/', PDFJS_BASE).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', PDFJS_BASE).href,
    wasmUrl: new URL('wasm/', PDFJS_BASE).href,
    iccUrl: new URL('iccs/', PDFJS_BASE).href,
    isEvalSupported: false, // lets the CSP drop 'unsafe-eval'
  });
  state.pendingLoadingTask = loadingTask;

  loadingTask.onPassword = (updatePassword, reason) => {
    const retry = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
    Promise.resolve(opts.requestPassword(retry)).then((password) => {
      if (password === null || password === undefined || openId !== state.openSequence) {
        passwordCanceled = true;
        loadingTask.destroy().catch(() => {});
      } else {
        updatePassword(password);
      }
    }).catch((error) => {
      console.error('gloss: password prompt failed:', error);
      passwordCanceled = true;
      loadingTask.destroy().catch(() => {});
    });
  };

  const abandon = (code, message) => {
    if (state.pendingLoadingTask === loadingTask) state.pendingLoadingTask = null;
    loadingTask.destroy().catch(() => {});
    return { ok: false, code, message };
  };

  let doc;
  let page1;
  let vp1;
  try {
    doc = await loadingTask.promise;
    if (openId !== state.openSequence) {
      return abandon('superseded', '');
    }
    // Reading page 1 is part of validation: a file can pass the header check
    // and still fail here.
    page1 = await doc.getPage(1);
    vp1 = page1.getViewport({ scale: 1 });
  } catch (err) {
    if (openId !== state.openSequence) return abandon('superseded', '');
    if (passwordCanceled) return abandon('password_canceled', '');
    const name = err?.name || '';
    if (name === 'InvalidPDFException') {
      return abandon('corrupt', 'This file is not a valid PDF or is damaged.');
    }
    return abandon('open_failed', err?.message || 'The document could not be opened.');
  }
  if (openId !== state.openSequence) {
    return abandon('superseded', '');
  }

  // Validated — now it is safe to replace the current document. Everything
  // from here is synchronous; later async work (page rendering, text
  // assessment) captures state.generation itself.
  if (state.pendingLoadingTask === loadingTask) state.pendingLoadingTask = null;
  closeDocument();
  state.loadingTask = loadingTask;
  state.doc = doc;
  state.total = doc.numPages;
  state.rawBaseWidth = vp1.width;
  state.rawBaseHeight = vp1.height;
  state.rawPageDims.set(1, { w: vp1.width, h: vp1.height });

  const restore = opts.restore || null;
  state.rotation = [0, 90, 180, 270].includes(restore?.rotation) ? restore.rotation : 0;
  state.spreadMode = restore?.spreadMode === 'two-page' ? 'two-page' : 'single';
  refs.pages().classList.toggle('pages--spread', state.spreadMode === 'two-page');
  state.bookmarks = new Set(
    Array.isArray(restore?.bookmarks)
      ? restore.bookmarks.filter(n => Number.isInteger(n) && n >= 1 && n <= state.total)
      : []
  );
  const base = rotatedDims({ w: vp1.width, h: vp1.height });
  state.baseWidth = base.w;
  state.baseHeight = base.h;
  state.pageDims.set(1, base);
  state.zoomMode = restore?.zoomMode || 'fit-width';
  state.zoomScale = state.zoomMode === 'custom'
    ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, restore?.zoomScale || 1))
    : computeFitScale(state.zoomMode);

  buildPlaceholders();
  if (state.zoomMode !== 'custom') {
    const postLayoutScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, computeFitScale(state.zoomMode)));
    if (Math.abs(postLayoutScale - state.zoomScale) > 0.0005) {
      state.zoomScale = postLayoutScale;
      for (const wrapper of refs.pages().children) {
        sizeWrapper(wrapper, Number(wrapper.dataset.pageNumber));
      }
    }
  }
  setupObservers();

  if (restore && restore.topPage >= 1 && restore.topPage <= state.total) {
    scrollToPosition(restore.topPage, restore.topOffset);
  } else if (restore && restore.scrollFraction > 0) {
    // State saved by a release that only knew the overall scroll fraction.
    restoreScrollFraction(restore.scrollFraction);
  } else if (restore && restore.page > 1) {
    goToPage(restore.page, { instant: true });
  } else {
    refs.container().scrollTop = 0;
  }
  // Settle the page number before anyone is told the document is open, so
  // the toolbar never flashes "1" on a book reopened at page 240.
  const index = firstPageEndingAfter(refs.container().scrollTop);
  state.current = Math.min(state.total, Math.max(1, index + 1));
  updateCurrentPage();

  emit('documentopened', { name: opts.name, path: opts.path, total: state.total });
  emit('pagechanged', state.current);
  emit('rotationchanged', state.rotation);
  emit('spreadchanged', state.spreadMode);
  emit('bookmarkschanged', bookmarks());
  emit('historychanged', { canBack: false, canForward: false });
  emit('zoomchanged', { mode: state.zoomMode, scale: state.zoomScale });

  assessDocumentText().catch(() => {});
  return { ok: true };
}

/** Extract PDF metadata and page size info for the Document Properties dialog. */
export async function getDocumentMetadata() {
  if (!state.doc) return null;
  let info = {};
  let metadata = null;
  try {
    const res = await state.doc.getMetadata();
    info = res?.info || {};
    metadata = res?.metadata || null;
  } catch { /* metadata optional */ }
  const pick = (key, xmpKey) => {
    const fromXmp = xmpKey && typeof metadata?.get === 'function' ? metadata.get(xmpKey) : '';
    const raw = (fromXmp || info[key] || '');
    return typeof raw === 'string' ? raw.trim() : String(raw || '').trim();
  };
  return {
    title: pick('Title', 'dc:title'),
    author: pick('Author', 'dc:creator'),
    subject: pick('Subject', 'dc:description'),
    keywords: pick('Keywords', 'pdf:Keywords'),
    creator: pick('Creator', 'xmp:CreatorTool'),
    producer: pick('Producer', 'pdf:Producer'),
    pdfVersion: pick('PDFFormatVersion', ''),
    linearized: Boolean(info.IsLinearized),
    pages: state.total,
    widthPt: state.rawBaseWidth,
    heightPt: state.rawBaseHeight,
    rotation: state.rotation,
    fingerprint: documentFingerprint(),
  };
}

/** Document outline (or null). Items: {title, dest, items[]}. */
export async function getOutline() {
  if (!state.doc) return null;
  try {
    return await state.doc.getOutline();
  } catch {
    return null;
  }
}

/**
 * Resolve an outline entry or link annotation destination to a page number
 * (1-based) or null. A destination's first element is normally a page
 * reference, but it may already be a page index, and a named destination has
 * to be looked up in the document first.
 */
export async function resolveDestination(dest) {
  if (!state.doc || !dest) return null;
  const gen = state.generation;
  try {
    const explicit = typeof dest === 'string' ? await state.doc.getDestination(dest) : dest;
    if (gen !== state.generation) return null;
    if (!Array.isArray(explicit) || explicit.length === 0) return null;
    const ref = explicit[0];
    if (typeof ref === 'number') return Number.isInteger(ref) ? ref + 1 : null;
    if (!ref || typeof ref !== 'object') return null;
    const pageIndex = await state.doc.getPageIndex(ref);
    if (gen !== state.generation) return null;
    return Number.isInteger(pageIndex) ? pageIndex + 1 : null;
  } catch {
    return null;
  }
}

/**
 * Render one page to a standalone image for printing.
 *
 * Independent of what is on screen: the page is painted at `dpi` regardless
 * of the current zoom, honours the reader's rotation, and never the paper
 * tint (that is a CSS filter on the on-screen canvas only).
 * @returns {Promise<{url:string, widthPt:number, heightPt:number}|null>}
 *          an object URL the caller must revoke, or null on failure.
 */
export async function renderPageImage(n, { dpi = 150, maxPixels = 12e6 } = {}) {
  if (!state.doc) return null;
  const gen = state.generation;
  let canvas = null;
  try {
    const page = await state.doc.getPage(n);
    if (gen !== state.generation) return null;
    const rotation = ((page.rotate || 0) + state.rotation) % 360;
    const base = page.getViewport({ scale: 1, rotation });
    let scale = dpi / 72;
    const pixels = base.width * base.height * scale * scale;
    if (pixels > maxPixels) scale *= Math.sqrt(maxPixels / pixels);
    const viewport = page.getViewport({ scale, rotation });

    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext('2d', { alpha: false });
    await page.render({ canvas: null, canvasContext: ctx, viewport, intent: 'print' }).promise;
    if (gen !== state.generation) return null;

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    return blob
      ? { url: URL.createObjectURL(blob), widthPt: base.width, heightPt: base.height }
      : null;
  } catch (error) {
    console.warn(`gloss: page ${n} could not be rendered for printing:`, error?.message || error);
    return null;
  } finally {
    // Release the bitmap now rather than whenever the collector gets to it:
    // a long book renders hundreds of these in a row.
    if (canvas) canvas.width = canvas.height = 0;
  }
}

/** Render a page thumbnail; returns an object URL (caller revokes). */
export async function renderThumbnail(n, cssWidth) {
  if (!state.doc) return null;
  const gen = state.generation;
  try {
    const page = await state.doc.getPage(n);
    if (gen !== state.generation) return null;
    const effectiveRotation = ((page.rotate || 0) + state.rotation) % 360;
    const vp1 = page.getViewport({ scale: 1, rotation: effectiveRotation });
    const scale = cssWidth / vp1.width;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: scale * ratio, rotation: effectiveRotation });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    await page.render({ canvas: null, canvasContext: ctx, viewport }).promise;
    if (gen !== state.generation) return null;
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.72));
    canvas.width = canvas.height = 0;
    return blob ? URL.createObjectURL(blob) : null;
  } catch {
    return null;
  }
}
