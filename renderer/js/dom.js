/** dom.js — element refs and tiny DOM helpers shared by renderer modules. */

export const $ = (id) => document.getElementById(id);

export const refs = {
  toolbar: () => $('toolbar'),
  container: () => $('pdf-container'),
  pages: () => $('pages'),
  emptyState: () => $('empty-state'),
  pageInput: () => $('page-input'),
  pageTotal: () => $('page-total'),
  zoomLevel: () => $('zoom-level'),
  searchBar: () => $('search-bar'),
  searchInput: () => $('search-input'),
  searchCount: () => $('search-count'),
  sidebar: () => $('sidebar'),
  popup: () => $('popup'),
  prefsOverlay: () => $('prefs-overlay'),
  passwordOverlay: () => $('password-overlay'),
  docBanner: () => $('doc-banner'),
  toast: () => $('toast'),
  srStatus: () => $('sr-status'),
};

export function show(el) { el.hidden = false; }
export function hide(el) { el.hidden = true; }
export function isShown(el) { return !el.hidden; }

/** Escape text for interpolation into innerHTML templates. */
export function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let reducedMotionQuery = null;
export function prefersReducedMotion() {
  if (!reducedMotionQuery) reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  return reducedMotionQuery.matches;
}

/** behavior for programmatic scrolling, honoring prefers-reduced-motion. */
export function scrollBehavior() {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}

/** Announce a short status message to assistive technology. */
export function announce(message) {
  const el = refs.srStatus();
  if (!el) return;
  el.textContent = '';
  // Re-set on a microtask boundary so repeated identical messages re-announce.
  queueMicrotask(() => { el.textContent = message; });
}

let toastTimer = null;
export function toast(message, { long = false } = {}) {
  const el = refs.toast();
  if (!el) return;
  el.textContent = message;
  show(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hide(el), long ? 6000 : 3200);
  announce(message);
}

export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}
