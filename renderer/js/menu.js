/**
 * menu.js — anchored popover menus (the toolbar's Sources list and its
 * overflow menu).
 *
 * A menu opens under its anchor button, right-aligned and clamped to the
 * window, and never taller than the space below the toolbar. One menu is
 * open at a time. Arrow keys, Home and End move between items; Tab leaves
 * and closes; Escape is routed here by the app's layer stack (closeTopMenu)
 * so that it still closes exactly one layer.
 */

import { show, hide, isShown } from './dom.js';

const GAP = 6;      // between anchor and menu
const MARGIN = 8;   // between menu and window edge

/** Open menu controllers; at most one today, a stack keeps Escape honest. */
const openMenus = [];

function itemsOf(menu) {
  return [...menu.querySelectorAll('.menu-item')].filter(item => !item.disabled);
}

/**
 * @param {{menu: HTMLElement, anchor: HTMLElement, onBeforeOpen?: () => void}} options
 */
export function createMenu({ menu, anchor, onBeforeOpen = null }) {
  function position() {
    if (!isShown(menu)) return;
    const a = anchor.getBoundingClientRect();
    // The anchor can vanish while the menu is open (the toolbar folds or
    // unfolds a control on resize). A menu pointing at nothing is closed.
    if (a.width === 0 && a.height === 0) { api.close(); return; }
    const top = a.bottom + GAP;
    menu.style.maxHeight = `${Math.max(140, window.innerHeight - top - MARGIN)}px`;
    const width = menu.offsetWidth;
    const left = Math.max(MARGIN, Math.min(a.right - width, window.innerWidth - width - MARGIN));
    menu.style.top = `${Math.round(top)}px`;
    menu.style.left = `${Math.round(left)}px`;
  }

  const api = {
    menu,
    anchor,
    isOpen: () => isShown(menu),
    reposition: position,

    open({ focusFirst = true } = {}) {
      if (api.isOpen()) return;
      closeAllMenus();
      onBeforeOpen?.();
      show(menu);
      anchor.setAttribute('aria-expanded', 'true');
      openMenus.push(api);
      position();
      if (focusFirst) itemsOf(menu)[0]?.focus({ preventScroll: true });
    },

    close({ restoreFocus = false } = {}) {
      if (!api.isOpen()) return false;
      const hadFocus = menu.contains(document.activeElement);
      hide(menu);
      anchor.setAttribute('aria-expanded', 'false');
      const index = openMenus.indexOf(api);
      if (index !== -1) openMenus.splice(index, 1);
      if ((restoreFocus || hadFocus) && anchor.offsetParent !== null) anchor.focus({ preventScroll: true });
      return true;
    },

    toggle() {
      if (api.isOpen()) api.close({ restoreFocus: true });
      else api.open();
    },
  };

  anchor.addEventListener('click', () => api.toggle());

  menu.addEventListener('keydown', (event) => {
    const items = itemsOf(menu);
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement);
    let next = -1;
    if (event.key === 'ArrowDown') next = (index + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'Tab') { api.close(); return; }
    else return;
    event.preventDefault();
    event.stopPropagation(); // these keys belong to the menu, not the document
    items[next].focus();
  });

  return api;
}

/** A pointer press anywhere outside an open menu (and its button) closes it. */
document.addEventListener('pointerdown', (event) => {
  for (const api of [...openMenus]) {
    if (!api.menu.contains(event.target) && !api.anchor.contains(event.target)) api.close();
  }
}, true);

window.addEventListener('resize', () => {
  for (const api of [...openMenus]) api.reposition();
});

export function anyMenuOpen() {
  return openMenus.length > 0;
}

/** Close the most recently opened menu; returns whether one was open. */
export function closeTopMenu() {
  const top = openMenus[openMenus.length - 1];
  return top ? top.close({ restoreFocus: true }) : false;
}

export function closeAllMenus() {
  for (const api of [...openMenus]) api.close();
}
