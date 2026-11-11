/**
 * sources.js — the toolbar's "Sources" control.
 *
 * Which dictionaries answer a lookup is the one setting a reader changes
 * mid-book, so it lives in the toolbar. A row of chips could show two or
 * three sources; a real shelf has a dozen or more and pushed the rest of the
 * toolbar — Preferences included — off the edge of the window. One button
 * with a count, opening a checklist that scrolls, scales to any shelf.
 *
 * The list is grouped the way lookups are answered: this book's own
 * glossary, then general dictionaries in priority order, then the two
 * online tiers. Glossaries belonging to other books stay loaded but are not
 * listed, exactly as before.
 */

import { $, esc } from './dom.js';
import { createMenu } from './menu.js';

const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const numberFormat = new Intl.NumberFormat();

let els = null;
let menu = null;
let hooks = null;

/**
 * @param {{onToggleDictionary: (path: string) => Promise<void>,
 *          onToggleOnline: (which: 'wiktionary'|'wikipedia') => Promise<void>,
 *          onManage: () => void}} callbacks
 */
export function init(callbacks) {
  hooks = callbacks;
  els = { button: $('btn-sources'), count: $('sources-count'), menu: $('sources-menu') };
  menu = createMenu({ menu: els.menu, anchor: els.button });

  els.menu.addEventListener('click', async (event) => {
    const item = event.target.closest('.menu-item');
    if (!item || item.disabled) return;

    if (item.dataset.sourceManage) {
      menu.close();
      hooks.onManage();
      return;
    }

    // The checklist stays open: switching several sources in one visit is the
    // common case. Remember which row was used so focus survives the redraw.
    const key = item.dataset.sourcePath
      ? `[data-source-path="${CSS.escape(item.dataset.sourcePath)}"]`
      : item.dataset.sourceWikt ? '[data-source-wikt]' : '[data-source-wiki]';
    const scroller = els.menu.querySelector('.menu-scroll');
    const scrollTop = scroller?.scrollTop || 0;
    item.disabled = true;
    try {
      if (item.dataset.sourcePath) await hooks.onToggleDictionary(item.dataset.sourcePath);
      else if (item.dataset.sourceWikt) await hooks.onToggleOnline('wiktionary');
      else if (item.dataset.sourceWiki) await hooks.onToggleOnline('wikipedia');
    } finally {
      // The callbacks re-render the list; this only matters if they failed.
      if (item.isConnected) item.disabled = false;
      if (menu.isOpen()) {
        const again = els.menu.querySelector('.menu-scroll');
        if (again) again.scrollTop = scrollTop;
        els.menu.querySelector(key)?.focus({ preventScroll: true });
      }
    }
  });
}

function row({ attrs, label, hint = '', checked, title = '', warn = false }) {
  return `
    <button class="menu-item" role="menuitemcheckbox" aria-checked="${checked}" ${attrs}
            ${title ? `title="${esc(title)}"` : ''}>
      <span class="menu-item-icon">${checked ? CHECK : ''}</span>
      <span class="menu-item-label">${esc(label)}</span>
      ${hint ? `<span class="menu-item-hint${warn ? ' menu-item-hint--warn' : ''}">${esc(hint)}</span>` : ''}
    </button>`;
}

function dictionaryRow(d) {
  const hint = d.error
    ? 'needs reload'
    : d.entryCount == null ? '' : numberFormat.format(d.entryCount);
  return row({
    attrs: `data-source-path="${esc(d.path)}"`,
    label: d.name,
    hint,
    warn: !!d.error,
    checked: !!d.enabled,
    title: `${d.name} — ${d.enabled ? 'on' : 'off'}`,
  });
}

/** Redraw the button's count and the checklist from current state. */
export function render(dictionaries, prefs) {
  if (!els) return;
  const applicable = dictionaries.filter(d => d.applicable);
  const forBook = applicable.filter(d => d.kind === 'glossary' && d.scope === 'book');
  const general = applicable.filter(d => !(d.kind === 'glossary' && d.scope === 'book'));

  const on = applicable.filter(d => d.enabled).length +
    (prefs.wiktionaryEnabled ? 1 : 0) + (prefs.wikipediaEnabled ? 1 : 0);
  const total = applicable.length + 2;

  els.count.textContent = String(on);
  els.button.classList.toggle('btn--muted', on === 0);
  const summary = `${on} of ${total} lookup ${total === 1 ? 'source' : 'sources'} on`;
  els.button.title = `Lookup sources — ${summary}`;
  els.button.setAttribute('aria-label', `Lookup sources, ${summary}`);

  const sections = [];
  if (forBook.length > 0) {
    sections.push(`<div class="menu-label">This book</div>${forBook.map(dictionaryRow).join('')}`);
  }
  sections.push(general.length > 0
    ? `<div class="menu-label">Dictionaries</div>${general.map(dictionaryRow).join('')}`
    : `<div class="menu-label">Dictionaries</div>
       <p class="menu-note">No local dictionaries yet. Add an MDX dictionary or a JSON glossary to look words up offline.</p>`);
  sections.push(`<div class="menu-label">Online</div>${
    row({
      attrs: 'data-source-wikt="1"',
      label: 'Wiktionary',
      hint: 'word meanings',
      checked: !!prefs.wiktionaryEnabled,
      title: `Wiktionary — ${prefs.wiktionaryEnabled ? 'on' : 'off'}`,
    })}${
    row({
      attrs: 'data-source-wiki="1"',
      label: 'Wikipedia',
      hint: `names & concepts · ${prefs.wikipediaLang}`,
      checked: !!prefs.wikipediaEnabled,
      title: `Wikipedia (${prefs.wikipediaLang}) — ${prefs.wikipediaEnabled ? 'on' : 'off'}`,
    })}`);

  els.menu.innerHTML = `
    <div class="menu-head">
      <span class="menu-title">Lookup sources</span>
      <span class="menu-sub">${esc(summary.replace(' lookup sources', '').replace(' lookup source', ''))}</span>
    </div>
    <div class="menu-scroll" id="source-list">${sections.join('')}</div>
    <div class="menu-foot">
      <button class="menu-item" role="menuitem" data-source-manage="1">
        <span class="menu-item-icon"></span>
        <span class="menu-item-label">${general.length + forBook.length > 0 ? 'Manage dictionaries…' : 'Add dictionaries…'}</span>
      </button>
    </div>`;
  menu.reposition();
}

export function isOpen() {
  return !!menu?.isOpen();
}
