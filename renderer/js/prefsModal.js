/**
 * prefsModal.js — the Preferences dialog (dictionaries, lookup,
 * appearance, session). Modal with a minimal focus trap; Escape is
 * handled by the app-level layer stack.
 */

import { $, esc, isShown, openModal, closeModal } from './dom.js';
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
const SECTIONS = new Set(['dictionaries', 'lookup', 'appearance', 'session']);

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
}

export function isOpen() { return isShown(els.overlay); }

/** Open Preferences, optionally straight at one section. */
export function open(section = null) {
  if (section && SECTIONS.has(section)) activeSection = section;
  renderNav();
  renderSection();
  // openModal remembers what had focus, blocks the page behind, traps Tab.
  openModal(els.overlay, { focus: els.modal.querySelector('.modal-nav-btn--active') });
}

export function close() {
  if (!isOpen()) return;
  closeModal(els.overlay);
}

function renderNav() {
  for (const btn of els.nav.querySelectorAll('[data-section]')) {
    const active = btn.dataset.section === activeSection;
    btn.classList.toggle('modal-nav-btn--active', active);
    btn.setAttribute('aria-current', active ? 'true' : 'false');
  }
}

async function renderSection() {
  try {
    switch (activeSection) {
      case 'dictionaries': return await renderDictionaries();
      case 'lookup': return renderLookup();
      case 'appearance': return renderAppearance();
      case 'session': return await renderSession();
    }
  } catch (error) {
    console.error(`Gloss could not render the ${activeSection} preferences:`, error);
    els.body.innerHTML = `
      <h3 class="prefs-title">Preferences unavailable</h3>
      <p class="prefs-error" role="alert">Gloss could not load this section. The app and your current document are still usable.</p>
      <button class="btn" id="prefs-retry">Try again</button>`;
    $('prefs-retry')?.addEventListener('click', renderSection);
  }
}

// ── Dictionaries ──────────────────────────────────────────────────────────────

/** Load failures survive the re-render that follows them. */
let dictionaryError = '';

function dictionaryFailure(action, error) {
  console.error(`Gloss could not ${action}:`, error);
  dictionaryError = `Could not ${action}. Existing dictionaries and glossaries were kept.`;
}

async function renderDictionaries() {
  const dicts = await window.gloss.listDictionaries();
  const rows = dicts.length === 0
    ? '<p class="prefs-empty">No local sources yet. Add an MDX dictionary or a per-book JSON glossary.</p>'
    : dicts.map((d, i) => {
      const ready = d.entryCount == null ? '' : `${d.entryCount} ready`;
      const draft = d.draftCount ? `${d.draftCount} draft` : '';
      const count = [ready, draft].filter(Boolean).join(' · ');
      const scope = d.kind === 'mdx' || d.scope === 'global'
        ? 'all books'
        : d.applicable ? 'this book' : `for ${d.sourceFile || 'another book'}`;
      const type = d.kind === 'glossary' ? 'JSON glossary' : 'MDX dictionary';
      const health = d.error ? 'needs reload' : '';
      return `
      <div class="dict-row" data-path="${esc(d.path)}">
        <label class="switch" title="${d.enabled ? 'Enabled' : 'Disabled'}">
          <input type="checkbox" data-act="toggle" ${d.enabled ? 'checked' : ''}
                 aria-label="Enable ${esc(d.name)}">
          <span class="switch-slider"></span>
        </label>
        <span class="dict-info" title="${esc(d.path)}">
          <span class="dict-name">${esc(d.name)}</span>
          <span class="dict-meta${d.error ? ' dict-meta--error' : ''}">${esc([type, scope, count, health].filter(Boolean).join(' · '))}</span>
        </span>
        <span class="dict-actions">
          <button class="icon-btn" data-act="reload" aria-label="Reload ${esc(d.name)}" title="Reload from disk">${icons.refresh}</button>
          <button class="icon-btn" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(d.name)} up">${icons.up}</button>
          <button class="icon-btn" data-act="down" ${i === dicts.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(d.name)} down">${icons.down}</button>
          <button class="icon-btn icon-btn--danger" data-act="remove" aria-label="Remove ${esc(d.name)}">${icons.trash}</button>
        </span>
      </div>`;
    }).join('');

  els.body.innerHTML = `
    <h3 class="prefs-title">Dictionaries</h3>
    <p class="prefs-hint">MDX dictionaries work everywhere. A generated JSON glossary activates only
    for its own book. Reload it here after adding definitions while Gloss is open.</p>
    <div class="dict-list">${rows}</div>
    <button class="btn" id="prefs-add-dict">Add dictionaries…</button>
    ${dictionaryError ? `<p class="prefs-error" role="alert">${esc(dictionaryError)}</p>` : ''}`;

  $('prefs-add-dict').addEventListener('click', async () => {
    const button = $('prefs-add-dict');
    button.disabled = true;
    button.textContent = 'Loading…';
    try {
      const results = await window.gloss.addDictionaries();
      const failed = Array.isArray(results) ? results.filter(r => !r.success) : [];
      // Recorded before the re-render below, so the message is still on screen
      // afterwards instead of being wiped by it.
      dictionaryError = failed.length > 0
        ? `Could not load ${failed.map(f => `${f.name} (${f.error || 'error'})`).join(', ')}`
        : '';
      await hooks.onDictsChanged();
    } catch (error) {
      dictionaryFailure('add lookup sources', error);
    }
    await renderSection();
  });

  els.body.querySelector('.dict-list')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    btn.disabled = true;
    const dictPath = btn.closest('.dict-row').dataset.path;
    try {
      const dictsNow = await window.gloss.listDictionaries();
      const order = dictsNow.map(d => d.path);
      const idx = order.indexOf(dictPath);
      let result = { success: true };
      if (btn.dataset.act === 'remove') {
        result = await window.gloss.removeDictionary(dictPath);
      } else if (btn.dataset.act === 'reload') {
        result = await window.gloss.reloadDictionary(dictPath);
        dictionaryError = result.success ? ''
          : `Could not reload ${result.name || 'lookup source'} (${result.error || 'error'}). The previous working copy is still active.`;
      } else if (btn.dataset.act === 'up' && idx > 0) {
        [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
        result = await window.gloss.reorderDictionaries(order);
      } else if (btn.dataset.act === 'down' && idx >= 0 && idx < order.length - 1) {
        [order[idx], order[idx + 1]] = [order[idx + 1], order[idx]];
        result = await window.gloss.reorderDictionaries(order);
      }
      if (!result?.success) {
        if (btn.dataset.act !== 'reload') throw new Error(result?.error || 'Action was refused');
      }
      await hooks.onDictsChanged();
    } catch (error) {
      dictionaryFailure(`${btn.dataset.act} that lookup source`, error);
    }
    await renderSection();
  });

  els.body.querySelector('.dict-list')?.addEventListener('change', async (e) => {
    if (e.target.dataset.act !== 'toggle') return;
    e.target.disabled = true;
    try {
      const result = await window.gloss.toggleDictionary(e.target.closest('.dict-row').dataset.path);
      if (!result?.success) throw new Error('Lookup source is no longer loaded');
      dictionaryError = '';
      await hooks.onDictsChanged();
    } catch (error) {
      dictionaryFailure('toggle that lookup source', error);
    }
    await renderSection();
  });
}

async function savePreference(delta, rerender) {
  try {
    await hooks.applyPrefs(delta);
    if (rerender) rerender();
  } catch (error) {
    console.error('Gloss could not save a preference:', error);
    // Re-render from the last confirmed preferences so the control does not
    // claim a setting was saved when it was not.
    if (rerender) rerender();
    els.body.insertAdjacentHTML('beforeend',
      '<p class="prefs-error" role="alert">That preference could not be saved. The previous setting is still active.</p>');
  }
}

// ── Lookup ────────────────────────────────────────────────────────────────────

function renderLookup() {
  const prefs = hooks.getPrefs();
  const langOptions = WIKI_LANG_LABELS.map(([code, label]) =>
    `<option value="${code}" ${prefs.wikipediaLang === code ? 'selected' : ''}>${label}</option>`).join('');

  const modeGroup = (name, isFallback) => `
    <div class="prefs-radio-group" role="radiogroup" aria-label="${esc(name)} mode">
      <label><input type="radio" name="${name}-mode" value="fallback" ${isFallback ? 'checked' : ''}>
        Only when no dictionary has a match</label>
      <label><input type="radio" name="${name}-mode" value="always" ${isFallback ? '' : 'checked'}>
        Always, alongside dictionary results</label>
    </div>`;

  els.body.innerHTML = `
    <h3 class="prefs-title">Lookup</h3>

    <div class="prefs-field">
      <label class="switch">
        <input type="checkbox" id="wikt-enabled" ${prefs.wiktionaryEnabled ? 'checked' : ''}>
        <span class="switch-slider"></span>
      </label>
      <label for="wikt-enabled">Use Wiktionary for word meanings</label>
    </div>
    <div class="prefs-subgroup ${prefs.wiktionaryEnabled ? '' : 'prefs-subgroup--disabled'}">
      ${modeGroup('wikt', prefs.wiktionaryAsFallback)}
      <p class="prefs-hint">Senses, parts of speech and usage — the dictionary answer.
      Devanagari headwords come back glossed in English.</p>
    </div>

    <div class="prefs-field">
      <label class="switch">
        <input type="checkbox" id="wiki-enabled" ${prefs.wikipediaEnabled ? 'checked' : ''}>
        <span class="switch-slider"></span>
      </label>
      <label for="wiki-enabled">Use Wikipedia for names and concepts</label>
    </div>
    <div class="prefs-subgroup ${prefs.wikipediaEnabled ? '' : 'prefs-subgroup--disabled'}">
      ${modeGroup('wiki', prefs.wikipediaAsFallback)}
    </div>

    <div class="prefs-field">
      <label for="wiki-lang">Preferred language</label>
      <select id="wiki-lang">${langOptions}</select>
    </div>

    <div class="prefs-field">
      <label class="switch">
        <input type="checkbox" id="websearch-enabled" ${prefs.webSearchLinkEnabled ? 'checked' : ''}>
        <span class="switch-slider"></span>
      </label>
      <label for="websearch-enabled">Show a “Search the web” link in the popup</label>
    </div>

    <p class="prefs-hint">Dictionary and glossary lookups are entirely local. Wiktionary and
    Wikipedia are the only requests Gloss makes on its own, and only at lookup time. The web
    search link sends nothing anywhere until you click it, and then it opens your browser.</p>`;

  $('wikt-enabled').addEventListener('change', (e) =>
    savePreference({ wiktionaryEnabled: e.target.checked }, renderLookup));
  $('wiki-enabled').addEventListener('change', (e) =>
    savePreference({ wikipediaEnabled: e.target.checked }, renderLookup));
  $('websearch-enabled').addEventListener('change', (e) =>
    savePreference({ webSearchLinkEnabled: e.target.checked }, renderLookup));

  for (const radio of els.body.querySelectorAll('[name="wikt-mode"]')) {
    radio.addEventListener('change', (e) => savePreference(
      { wiktionaryAsFallback: e.target.value === 'fallback' }, renderLookup));
  }
  for (const radio of els.body.querySelectorAll('[name="wiki-mode"]')) {
    radio.addEventListener('change', (e) => savePreference(
      { wikipediaAsFallback: e.target.value === 'fallback' }, renderLookup));
  }
  $('wiki-lang').addEventListener('change', (e) =>
    savePreference({ wikipediaLang: e.target.value }, renderLookup));
}

// ── Appearance ────────────────────────────────────────────────────────────────

function renderAppearance() {
  const prefs = hooks.getPrefs();
  const radio = (name, current, value, label) => `
    <label><input type="radio" name="${name}" value="${value}" ${current === value ? 'checked' : ''}> ${label}</label>`;
  const currentTone = prefs.pageTone || 'original';
  els.body.innerHTML = `
    <h3 class="prefs-title">Appearance</h3>
    <p class="prefs-hint">Choose how the application frame and PDF pages are tinted.</p>
    <div class="prefs-section-label">Interface theme</div>
    <div class="prefs-radio-group" role="radiogroup" aria-label="Theme">
      ${radio('theme', prefs.theme, 'system', 'Follow system')}
      ${radio('theme', prefs.theme, 'light', 'Light')}
      ${radio('theme', prefs.theme, 'dark', 'Dark')}
    </div>
    <div class="prefs-section-label">Page paper tint</div>
    <div class="prefs-radio-group" role="radiogroup" aria-label="Page paper tint">
      ${radio('pageTone', currentTone, 'original', 'Original white — exact colours and figures')}
      ${radio('pageTone', currentTone, 'warm', 'Warm paper — softer daylight stock')}
      ${radio('pageTone', currentTone, 'sepia', 'Sepia — classic book paper')}
      ${radio('pageTone', currentTone, 'dark', 'Night page — dark charcoal for low light')}
    </div>
    <p class="prefs-hint">You can also cycle the page tint anytime with <code>Ctrl+Shift+D</code> or the toolbar button.</p>`;
  for (const input of els.body.querySelectorAll('[name="theme"]')) {
    input.addEventListener('change', (e) =>
      savePreference({ theme: e.target.value }, renderAppearance));
  }
  for (const input of els.body.querySelectorAll('[name="pageTone"]')) {
    input.addEventListener('change', (e) =>
      savePreference({ pageTone: e.target.value }, renderAppearance));
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
  $('prefs-clear-cache').addEventListener('click', () => {
    hooks.clearLookupCache();
    renderSection();
  });
  $('prefs-clear-recents').addEventListener('click', async () => {
    try {
      await window.gloss.clearRecents();
      await hooks.onRecentsCleared?.();
      await renderSection();
    } catch (error) {
      console.error('Gloss could not clear recent documents:', error);
      els.body.insertAdjacentHTML('beforeend',
        '<p class="prefs-error" role="alert">Recent documents could not be cleared.</p>');
    }
  });
}
