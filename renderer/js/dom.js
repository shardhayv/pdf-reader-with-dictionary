/** dom.js — element refs and tiny DOM helpers shared by renderer modules. */

export const $ = (id) => document.getElementById(id);

export const refs = {
  toolbar: () => $('toolbar'),
  container: () => $('pdf-container'),
  pages: () => $('pages'),
  emptyState: () => $('empty-state'),
  pageInput: () => $('page-input'),
  pageTotal: () => $('page-total'),
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

// ── Focus and modal layers ────────────────────────────────────────────────────

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Visible, enabled, focusable descendants in tab order. */
export function focusables(container) {
  return [...container.querySelectorAll(FOCUSABLE)]
    .filter(node => !node.disabled && node.offsetParent !== null);
}

/** Keep Tab / Shift+Tab inside `container` (call from its keydown handler). */
export function trapFocus(container, event) {
  if (event.key !== 'Tab') return;
  const nodes = focusables(container);
  if (nodes.length === 0) { event.preventDefault(); return; }
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !container.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

/** Open modal overlays, bottom to top. */
const modalStack = [];

/**
 * Everything behind the top modal is made inert, so neither the pointer, the
 * Tab key nor a screen reader can wander into a toolbar the dialog covers.
 */
function syncModalInertness() {
  const top = modalStack[modalStack.length - 1] || null;
  for (const el of document.querySelectorAll('.app-shell, #popup, .menu')) el.inert = !!top;
  for (const overlay of modalStack) overlay.inert = overlay !== top;
}

/**
 * Show a modal overlay: remembers what had focus, blocks the page behind it,
 * traps Tab, and focuses `focus` (or the first control).
 */
export function openModal(overlay, { focus = null } = {}) {
  if (!modalStack.includes(overlay)) {
    overlay._returnFocus = document.activeElement;
    modalStack.push(overlay);
    if (!overlay._trapsFocus) {
      overlay._trapsFocus = true;
      overlay.addEventListener('keydown', (event) => trapFocus(overlay, event));
    }
  }
  show(overlay);
  syncModalInertness();
  (focus || focusables(overlay)[0])?.focus();
}

/** Hide a modal overlay and hand focus back to wherever it came from. */
export function closeModal(overlay) {
  const index = modalStack.indexOf(overlay);
  // Let go of focus before the dialog disappears. Hiding a focused element
  // leaves the browser to notice at its next frame, and a Tab pressed inside
  // that window started from a node that no longer exists.
  if (overlay.contains(document.activeElement)) document.activeElement.blur();
  hide(overlay);
  if (index === -1) return;
  modalStack.splice(index, 1);
  syncModalInertness();
  const back = overlay._returnFocus;
  overlay._returnFocus = null;
  const usable = back && back !== document.body && back.isConnected &&
    typeof back.focus === 'function' && back.offsetParent !== null;
  // Nothing in particular had focus (the dialog was opened from the menu or
  // by shortcut): hand the keyboard to the page, where reading keys work.
  (usable ? back : refs.container())?.focus({ preventScroll: true });
}

/** True while any modal dialog is open — the document must ignore its keys. */
export function modalOpen() {
  return modalStack.length > 0;
}

/** Next animation frame, as a promise. */
export function nextFrame() {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

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
