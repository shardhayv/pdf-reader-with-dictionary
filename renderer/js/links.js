/**
 * links.js — decides when a PDF link annotation becomes an action.
 *
 * The link overlay drawn by viewer.js takes no pointer events, so selecting
 * text over a link works exactly as it does anywhere else. Clicks are matched
 * to a link by hit-testing the overlay's rectangles here instead.
 *
 * Nothing in this file can navigate the app frame: external links go out
 * through the user-initiated shell:openExternal channel to the system browser,
 * and internal links are page jumps inside the viewer.
 *
 * Double-clicking a word is Gloss's primary gesture, and linked words are
 * still words. A click on a link is therefore held for a moment: if a second
 * click arrives, or a selection turns out to exist, the lookup wins and the
 * link is abandoned.
 */

import * as viewer from './viewer.js';

const SETTLE_MS = 180;

let onExternal = null;
let onFailure = null;
let pendingTimer = null;
let hoverEl = null;
let hoverFrame = 0;

function cancelPending() {
  clearTimeout(pendingTimer);
  pendingTimer = null;
}

function linkAt(wrapper, x, y) {
  // Rects come from the live elements, so any zoom transform on the layer is
  // already accounted for.
  for (const el of wrapper.querySelectorAll('.pdf-link')) {
    const r = el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return el;
  }
  return null;
}

function hasSelection() {
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed && String(sel).trim().length > 0;
}

async function activate(el) {
  if (!el?.isConnected) return;
  try {
    const external = el.dataset.external;
    if (external) {
      await onExternal?.(external);
      return;
    }
    const page = await viewer.resolveDestination(el._dest);
    if (page) viewer.goToPage(page);
    else onFailure?.('That link does not point anywhere in this document.');
  } catch (error) {
    console.error('gloss: could not follow a PDF link:', error);
    onFailure?.('That link could not be opened.');
  }
}

function handleClick(e) {
  if (e.button !== 0) return;
  // The second click of a double-click: the reader meant to look up a word.
  if (e.detail > 1) { cancelPending(); return; }
  const wrapper = e.target.closest?.('.pdf-page-wrapper');
  if (!wrapper) return;
  const el = linkAt(wrapper, e.clientX, e.clientY);
  if (!el) return;

  cancelPending();
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    if (hasSelection()) return; // a drag-selection ended on the link
    activate(el);
  }, SETTLE_MS);
}

function setHover(el) {
  if (hoverEl === el) return;
  hoverEl?.classList.remove('pdf-link--hover');
  hoverEl = el;
  hoverEl?.classList.add('pdf-link--hover');
  document.body.classList.toggle('has-link-hover', !!el);
}

function handleMove(e) {
  if (hoverFrame) return; // one hit-test per frame is plenty
  const { clientX, clientY, target } = e;
  hoverFrame = requestAnimationFrame(() => {
    hoverFrame = 0;
    const wrapper = target.closest?.('.pdf-page-wrapper');
    setHover(wrapper ? linkAt(wrapper, clientX, clientY) : null);
  });
}

/** Links are focusable, so Enter and Space must work without a pointer. */
function handleKeydown(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target.closest?.('.pdf-link');
  if (!el) return;
  e.preventDefault();
  cancelPending();
  activate(el);
}

export function attach(container, { openExternal, onError } = {}) {
  onExternal = openExternal;
  onFailure = onError;
  container.addEventListener('click', handleClick);
  container.addEventListener('dblclick', cancelPending);
  container.addEventListener('mousemove', handleMove);
  container.addEventListener('keydown', handleKeydown);
  container.addEventListener('mouseleave', () => setHover(null));
}
