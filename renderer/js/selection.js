/**
 * selection.js — decides when a selection becomes a lookup.
 *
 * Lookups fire only for selections that live entirely inside a genuine
 * PDF text layer: never from toolbars, dialogs, the popup, empty-state,
 * or any other UI. One pointerup → at most one lookup. Long selections
 * (copying) do not auto-trigger; Ctrl+D / the menu force a lookup.
 */

import { isAutoLookupCandidate, collapseWhitespace, trimEdges, segmentWords } from './text.js';

const FORCE_LOOKUP_MAX_CHARS = 200;

/**
 * A double-click delivers two pointerup events. Reading the selection has
 * to be deferred (it is not final until after pointerup), and by the time
 * the first read runs the second click has already selected the word — so
 * both events would see the same selection and fire two lookups. A trailing
 * coalesce collapses any burst of pointerups into a single lookup, and also
 * keeps the app quiet while a drag-selection is still being adjusted.
 */
const SELECTION_SETTLE_MS = 150;

let onLookup = null;
let pendingTimer = null;

function cancelPending() {
  clearTimeout(pendingTimer);
  pendingTimer = null;
}

function selectionInsideTextLayer(sel) {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  const within = (node) => {
    const elNode = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return !!elNode?.closest('.pdf-text-layer');
  };
  return within(sel.anchorNode) && within(sel.focusNode);
}

function currentSelection() {
  const sel = window.getSelection();
  if (!selectionInsideTextLayer(sel)) return null;
  const raw = sel.toString();
  if (!raw || !raw.trim()) return null;
  return { raw, rect: sel.getRangeAt(0).getBoundingClientRect() };
}

function snapWhitespaceDoubleClick() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !selectionInsideTextLayer(sel)) return;
  if (trimEdges(sel.toString())) return;
  const node = sel.anchorNode;
  if (!node || node.nodeType !== Node.TEXT_NODE) return;
  const text = node.textContent || '';
  const offset = sel.anchorOffset;
  const words = segmentWords(text).filter(s => s.isWordLike);
  if (words.length === 0) return;
  let best = words[0];
  let bestDist = Infinity;
  for (const w of words) {
    const end = w.index + w.segment.length;
    const dist = offset < w.index ? w.index - offset : (offset > end ? offset - end : 0);
    if (dist < bestDist) {
      best = w;
      bestDist = dist;
    }
  }
  const range = document.createRange();
  range.setStart(node, best.index);
  range.setEnd(node, best.index + best.segment.length);
  sel.removeAllRanges();
  sel.addRange(range);
}

function handlePointerUp(e) {
  if (e.button !== 0) return;
  if (!e.target.closest?.('.pdf-text-layer')) return;
  cancelPending();
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    const found = currentSelection();
    if (!found) return;
    if (!isAutoLookupCandidate(found.raw)) return; // deliberate long copy — stay quiet
    onLookup?.(found.raw, found.rect);
  }, SELECTION_SETTLE_MS);
}

function handleDoubleClick(e) {
  if (e.button !== 0) return;
  if (!e.target.closest?.('.pdf-text-layer')) return;
  snapWhitespaceDoubleClick();
}

export function attach(container, lookupFn) {
  onLookup = lookupFn;
  container.addEventListener('pointerup', handlePointerUp);
  container.addEventListener('dblclick', handleDoubleClick);
}

/** Ctrl+D / View → Look Up Selection: force lookup of any selection. */
export function defineCurrentSelection() {
  cancelPending(); // never let an auto-lookup fire on top of an explicit one
  const found = currentSelection();
  if (!found) return false;
  const text = collapseWhitespace(found.raw);
  if (!text || text.length > FORCE_LOOKUP_MAX_CHARS) return false;
  onLookup?.(found.raw, found.rect);
  return true;
}
