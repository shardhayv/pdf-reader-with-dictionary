/**
 * toolbar.js — a toolbar that fits whatever width it is given.
 *
 * Breakpoints cannot do this job: the toolbar's natural width depends on the
 * platform's interface font, the page count ("of 9" versus "of 1204"), which
 * history buttons exist right now, and the system text scale. So instead of
 * guessing, the toolbar is measured.
 *
 * Nothing in it may shrink, wrap or clip (see the .toolbar rules in
 * style.css). relayout() then walks an explicit ladder until the content
 * fits:
 *
 *   1. everything shown, labels on;
 *   2. compact — text labels drop, spacing tightens;
 *   3. controls fold into the "More" menu, least-used first.
 *
 * The opening control, sidebar, find, the page number, lookup sources and
 * Preferences never fold, so the essentials stay one click away at any size.
 * A folded control is hidden with a class, never removed: its click handler,
 * pressed state and tooltip stay live, and the menu simply forwards to it.
 */

import { $, esc } from './dom.js';
import { createMenu } from './menu.js';

/** Fold order: first entry goes first. Each entry folds as one unit. */
const FOLD_ORDER = [
  ['btn-doc-info'],
  ['btn-page-tone'],
  ['btn-rotate'],
  ['btn-bookmark'],
  ['btn-spread'],
  ['btn-history-back', 'btn-history-forward'],
  ['btn-zoom-out', 'btn-zoom-in'],
  ['zoom-menu'],
  ['btn-prev-page', 'btn-next-page'],
];

/** Reading order inside the More menu (independent of fold order). */
const MENU_SECTIONS = [
  ['btn-prev-page', 'btn-next-page', 'btn-history-back', 'btn-history-forward'],
  ['btn-zoom-out', 'btn-zoom-in', 'zoom-menu'],
  ['btn-rotate', 'btn-spread', 'btn-bookmark', 'btn-page-tone', 'btn-doc-info'],
];

const ZOOM_PRESETS = [
  { value: 'fit-width', label: 'Fit width', hint: 'Ctrl+0' },
  { value: 'fit-page', label: 'Fit page', hint: 'Ctrl+Shift+0' },
  { value: '1', label: 'Actual size (100%)', hint: '' },
];

const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

let els = null;
let moreMenu = null;
let pending = 0;

export function init() {
  els = {
    toolbar: $('toolbar'),
    end: $('toolbar-end'),
    more: $('btn-more'),
    menu: $('more-menu'),
    folds: FOLD_ORDER.map(group => group.map(id => $(id)).filter(Boolean)),
  };
  moreMenu = createMenu({ menu: els.menu, anchor: els.more, onBeforeOpen: renderMoreMenu });

  els.menu.addEventListener('click', (event) => {
    const item = event.target.closest('.menu-item');
    if (!item || item.disabled) return;
    if (item.dataset.zoom) {
      const select = $('zoom-menu');
      select.value = item.dataset.zoom;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (item.dataset.forward) {
      $(item.dataset.forward)?.click();
    }
    // Zooming and paging are done in runs; closing after each press would
    // make the reader reopen the menu for every step.
    if ('stay' in item.dataset) renderMoreMenu({ keepFocusOn: item.dataset.forward });
    else moreMenu.close({ restoreFocus: true });
  });

  new ResizeObserver(() => requestRelayout()).observe(els.toolbar);
  // A late web-font swap changes every label's width.
  document.fonts?.ready?.then(() => requestRelayout()).catch(() => {});
  relayout();
}

/** Coalesce any number of layout-affecting changes into one pass per frame. */
export function requestRelayout() {
  if (pending) return;
  pending = requestAnimationFrame(() => {
    pending = 0;
    relayout();
  });
}

function fits() {
  // The last group is pushed right by its auto margin, so it sits flush with
  // the padding edge when there is room and sticks out past it when there is
  // not. Half a pixel absorbs sub-pixel rounding at fractional scale factors.
  const bar = els.toolbar.getBoundingClientRect();
  const padding = parseFloat(getComputedStyle(els.toolbar).paddingRight) || 0;
  return els.end.getBoundingClientRect().right <= bar.right - padding + 0.5;
}

/** Re-fit the toolbar. Synchronous: a few forced layouts on a tiny subtree. */
export function relayout() {
  if (!els) return;
  const bar = els.toolbar;
  bar.classList.remove('toolbar--compact');
  for (const group of els.folds) for (const el of group) el.classList.remove('is-folded');
  els.more.hidden = true;

  if (!fits()) {
    bar.classList.add('toolbar--compact');
    if (!fits()) {
      els.more.hidden = false;
      for (const group of els.folds) {
        for (const el of group) el.classList.add('is-folded');
        if (fits()) break;
      }
    }
  }

  // Only controls that are hidden anyway folded (say, history buttons with no
  // history): the menu would open empty, so do not offer it.
  if (!els.more.hidden && menuEntries().length === 0) els.more.hidden = true;

  if (moreMenu.isOpen()) {
    if (els.more.hidden) moreMenu.close();
    else { renderMoreMenu(); moreMenu.reposition(); }
  }
}

/** Folded controls that would actually be visible if there were room. */
function menuEntries() {
  const out = [];
  for (const section of MENU_SECTIONS) {
    const rows = section
      .map(id => $(id))
      .filter(el => el && el.classList.contains('is-folded') && !el.hidden);
    if (rows.length > 0) out.push(rows);
  }
  return out;
}

function forwardItem(el) {
  const pressed = el.getAttribute('aria-pressed');
  const toggle = pressed !== null;
  const icon = el.querySelector('svg')?.outerHTML || '';
  return `
    <button class="menu-item" role="${toggle ? 'menuitemcheckbox' : 'menuitem'}"
            ${toggle ? `aria-checked="${pressed === 'true'}"` : ''}
            data-forward="${esc(el.id)}" ${'menuStay' in el.dataset ? 'data-stay' : ''}
            ${el.disabled ? 'disabled' : ''}>
      <span class="menu-item-icon">${toggle && pressed === 'true' ? CHECK : icon}</span>
      <span class="menu-item-label">${esc(el.dataset.menuLabel || el.getAttribute('aria-label') || '')}</span>
      ${el.dataset.menuHint ? `<span class="menu-item-hint">${esc(el.dataset.menuHint)}</span>` : ''}
    </button>`;
}

function zoomItems(select) {
  return ZOOM_PRESETS.map(({ value, label, hint }) => {
    const current = select.value === value;
    return `
      <button class="menu-item" role="menuitemradio" aria-checked="${current}" data-zoom="${esc(value)}">
        <span class="menu-item-icon">${current ? CHECK : ''}</span>
        <span class="menu-item-label">${esc(label)}</span>
        ${hint ? `<span class="menu-item-hint">${esc(hint)}</span>` : ''}
      </button>`;
  }).join('');
}

function renderMoreMenu({ keepFocusOn = null } = {}) {
  const sections = menuEntries().map(rows => rows
    .map(el => (el.id === 'zoom-menu' ? zoomItems(el) : forwardItem(el)))
    .join(''));
  els.menu.innerHTML = sections.join('<div class="menu-rule" role="separator"></div>');
  if (keepFocusOn) {
    els.menu.querySelector(`[data-forward="${CSS.escape(keepFocusOn)}"]`)?.focus({ preventScroll: true });
  }
}

/** Test and diagnostics hook: which controls are currently in the More menu. */
export function foldedIds() {
  return els ? els.folds.flat().filter(el => el.classList.contains('is-folded')).map(el => el.id) : [];
}
