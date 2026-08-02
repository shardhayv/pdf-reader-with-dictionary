/**
 * prefsModal.js — the Preferences dialog (dictionaries, lookup,
 * appearance, session). Modal with a minimal focus trap; Escape is
 * handled by the app-level layer stack.
 */

import { $, esc, show, hide, isShown } from './dom.js';
import { icons } from './icons.js';

const WIKI_LANG_LABELS = [
  ['en', 'English'],
  ['hi', 'हिन्दी (Hindi)'],
  ['ne', 'नेपाली (Nepali)'],
  ['mai', 'मैथिली (Maithili)'],
];

let hooks = null; // { getPrefs, applyPrefs, onDictsChanged, sessionStats, clearLookupCache }
let els = null;
let activeSection = 'dictionaries';
let lastFocused = null;

export function init(hookset) {
  hooks = hookset;
  els = {
    overlay: $('prefs-overlay'),
    modal: $('prefs-modal'),
    body: $('prefs-body'),
    close: $('prefs-close'),
    nav: $('prefs-nav'),
  };
  els.close.innerHTML = icons.close;
  els.close.addEventListener('click', close);
  els.overlay.addEventListener('pointerdown', (e) => {
    if (e.target === els.overlay) close();
  });
  els.nav.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-section]');
    if (!btn) return;
    activeSection = btn.dataset.section;
    renderNav();
    renderSection();
  });
  els.modal.addEventListener('keydown', trapFocus);
}

export function isOpen() { return isShown(els.overlay); }

export function open() {
  lastFocused = document.activeElement;
  renderNav();
  renderSection();
  show(els.overlay);
  els.modal.querySelector('.modal-nav-btn--active')?.focus();
}

export function close() {
  if (!isOpen()) return;
  hide(els.overlay);
  if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
  lastFocused = null;
}

function trapFocus(e) {
  if (e.key !== 'Tab') return;
  const focusables = [...els.modal.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  )].filter(n => !n.disabled && n.offsetParent !== null);
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function renderNav() {
  for (const btn of els.nav.querySelectorAll('[data-section]')) {
    const active = btn.dataset.section === activeSection;
    btn.classList.toggle('modal-nav-btn--active', active);
    btn.setAttribute('aria-current', active ? 'true' : 'false');
  }
}

async function renderSection() {
  switch (activeSection) {
    case 'dictionaries': return renderDictionaries();
    case 'lookup': return renderLookup();
    case 'appearance': return renderAppearance();
    case 'session': return renderSession();
  }
}

// ── Dictionaries ──────────────────────────────────────────────────────────────

/** Load failures survive the re-render that follows them. */
let dictionaryError = '';

async function renderDictionaries() {
  const dicts = await window.gloss.listDictionaries();
  const rows = dicts.length === 0
    ? '<p class="prefs-empty">No dictionaries yet. Add MDX dictionaries to enable offline lookup.</p>'
    : dicts.map((d, i) => `
      <div class="dict-row" data-path="${esc(d.path)}">
        <label class="switch" title="${d.enabled ? 'Enabled' : 'Disabled'}">
          <input type="checkbox" data-act="toggle" ${d.enabled ? 'checked' : ''}
                 aria-label="Enable ${esc(d.name)}">
          <span class="switch-slider"></span>
        </label>
        <span class="dict-name" title="${esc(d.path)}">${esc(d.name)}</span>
        <span class="dict-actions">
          <button class="icon-btn" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(d.name)} up">${icons.up}</button>
          <button class="icon-btn" data-act="down" ${i === dicts.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(d.name)} down">${icons.down}</button>
          <button class="icon-btn icon-btn--danger" data-act="remove" aria-label="Remove ${esc(d.name)}">${icons.trash}</button>
        </span>
      </div>`).join('');

  els.body.innerHTML = `
    <h3 class="prefs-title">Dictionaries</h3>
    <p class="prefs-hint">Lookups try each enabled dictionary from top to bottom. Definitions from
    dictionary files are sandboxed and sanitized.</p>
    <div class="dict-list">${rows}</div>
    <button class="btn" id="prefs-add-dict">Add dictionaries…</button>
    ${dictionaryError ? `<p class="prefs-error" role="alert">${dictionaryError}</p>` : ''}`;

  $('prefs-add-dict').addEventListener('click', async () => {
    const results = await window.gloss.addDictionaries();
    const failed = results.filter(r => !r.success);
    // Recorded before the re-render below, so the message is still on screen
    // afterwards instead of being wiped by it.
    dictionaryError = failed.length > 0
      ? `Could not load ${failed.map(f => `${esc(f.name)} (${esc(f.error || 'error')})`).join(', ')}`
      : '';
    hooks.onDictsChanged();
    renderDictionaries();
  });

  els.body.querySelector('.dict-list')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const path = btn.closest('.dict-row').dataset.path;
    const dictsNow = await window.gloss.listDictionaries();
    const order = dictsNow.map(d => d.path);
    const idx = order.indexOf(path);
    if (btn.dataset.act === 'remove') {
      await window.gloss.removeDictionary(path);
    } else if (btn.dataset.act === 'up' && idx > 0) {
      [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
      await window.gloss.reorderDictionaries(order);
    } else if (btn.dataset.act === 'down' && idx >= 0 && idx < order.length - 1) {
      [order[idx], order[idx + 1]] = [order[idx + 1], order[idx]];
      await window.gloss.reorderDictionaries(order);
    }
    hooks.onDictsChanged();
    renderDictionaries();
  });

  els.body.querySelector('.dict-list')?.addEventListener('change', async (e) => {
    if (e.target.dataset.act !== 'toggle') return;
    await window.gloss.toggleDictionary(e.target.closest('.dict-row').dataset.path);
    hooks.onDictsChanged();
  });
}

// ── Lookup ────────────────────────────────────────────────────────────────────

function renderLookup() {
  const prefs = hooks.getPrefs();
  const langOptions = WIKI_LANG_LABELS.map(([code, label]) =>
    `<option value="${code}" ${prefs.wikipediaLang === code ? 'selected' : ''}>${label}</option>`).join('');

  els.body.innerHTML = `
    <h3 class="prefs-title">Lookup</h3>
    <div class="prefs-field">
      <label class="switch">
        <input type="checkbox" id="wiki-enabled" ${prefs.wikipediaEnabled ? 'checked' : ''}>
        <span class="switch-slider"></span>
      </label>
      <label for="wiki-enabled">Use Wikipedia as an online source</label>
    </div>
    <div class="prefs-subgroup ${prefs.wikipediaEnabled ? '' : 'prefs-subgroup--disabled'}" id="wiki-group">
      <div class="prefs-radio-group" role="radiogroup" aria-label="Wikipedia mode">
        <label><input type="radio" name="wiki-mode" value="fallback" ${prefs.wikipediaAsFallback ? 'checked' : ''}>
          Only when no dictionary has a match</label>
        <label><input type="radio" name="wiki-mode" value="always" ${prefs.wikipediaAsFallback ? '' : 'checked'}>
          Always, alongside dictionary results</label>
      </div>
      <div class="prefs-field">
        <label for="wiki-lang">Wikipedia language</label>
        <select id="wiki-lang">${langOptions}</select>
      </div>
    </div>
    <p class="prefs-hint">Dictionary lookups are entirely local. Wikipedia is the only network
    request Gloss ever makes, and only at lookup time.</p>`;

  $('wiki-enabled').addEventListener('change', async (e) => {
    await hooks.applyPrefs({ wikipediaEnabled: e.target.checked });
    renderLookup();
  });
  for (const radio of els.body.querySelectorAll('[name="wiki-mode"]')) {
    radio.addEventListener('change', (e) =>
      hooks.applyPrefs({ wikipediaAsFallback: e.target.value === 'fallback' }));
  }
  $('wiki-lang').addEventListener('change', (e) => hooks.applyPrefs({ wikipediaLang: e.target.value }));
}

// ── Appearance ────────────────────────────────────────────────────────────────

function renderAppearance() {
  const prefs = hooks.getPrefs();
  const radio = (value, label) => `
    <label><input type="radio" name="theme" value="${value}" ${prefs.theme === value ? 'checked' : ''}> ${label}</label>`;
  els.body.innerHTML = `
    <h3 class="prefs-title">Appearance</h3>
    <div class="prefs-radio-group" role="radiogroup" aria-label="Theme">
      ${radio('system', 'Follow system')}
      ${radio('light', 'Light')}
      ${radio('dark', 'Dark')}
    </div>`;
  for (const input of els.body.querySelectorAll('[name="theme"]')) {
    input.addEventListener('change', (e) => hooks.applyPrefs({ theme: e.target.value }));
  }
}

// ── Session ───────────────────────────────────────────────────────────────────

async function renderSession() {
  const stats = await hooks.sessionStats();
  els.body.innerHTML = `
    <h3 class="prefs-title">Session</h3>
    <div class="prefs-stat"><strong>${stats.dictionaries}</strong> ${stats.dictionaries === 1 ? 'dictionary' : 'dictionaries'} loaded</div>
    <div class="prefs-stat"><strong>${stats.cachedLookups}</strong> lookup${stats.cachedLookups === 1 ? '' : 's'} cached</div>
    <div class="prefs-stat"><strong>${stats.recents}</strong> recent document${stats.recents === 1 ? '' : 's'}</div>
    <div class="prefs-actions">
      <button class="btn" id="prefs-clear-cache">Clear lookup cache</button>
      <button class="btn" id="prefs-clear-recents">Clear recent documents</button>
    </div>`;
  $('prefs-clear-cache').addEventListener('click', () => { hooks.clearLookupCache(); renderSession(); });
  $('prefs-clear-recents').addEventListener('click', async () => {
    await window.gloss.clearRecents();
    hooks.onRecentsCleared?.();
    renderSession();
  });
}
