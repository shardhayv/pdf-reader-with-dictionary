/**
 * app.js — composition root.
 *
 * Wires the viewer, selection/lookup, search, sidebar and preferences
 * together; owns the keyboard layer stack, document open pipeline, and
 * persisted reading state.
 */

import { refs, $, esc, show, hide, isShown, toast, announce, debounce, scrollBehavior } from './dom.js';
import { icons } from './icons.js';
import * as viewer from './viewer.js';
import * as popup from './popup.js';
import * as lookup from './lookup.js';
import * as selection from './selection.js';
import * as search from './search.js';
import * as sidebar from './sidebar.js';
import * as prefsModal from './prefsModal.js';

const STATE_SAVE_DEBOUNCE_MS = 700;

const app = {
  prefs: null,
  docPath: null,
  docName: null,
  readMode: false,
  passwordResolve: null,
};

// ── Boot ──────────────────────────────────────────────────────────────────────

(async function boot() {
  app.prefs = await window.gloss.getPrefs();
  applyTheme(app.prefs.theme);
  lookup.setPrefs(app.prefs);

  popup.init({
    onEntryLookup: (word) => lookup.lookupEntry(word),
    onExternalOpen: (url) => window.gloss.openExternal(url),
  });
  search.init();
  sidebar.init({
    onVisibilityChange: (visible) => window.gloss.setPrefs({ sidebarVisible: visible }),
  });
  prefsModal.init({
    getPrefs: () => app.prefs,
    applyPrefs: applyPrefs,
    onDictsChanged: async () => {
      lookup.invalidateDictionaries();
      await refreshSourceChips();
    },
    onRecentsCleared: () => renderEmptyState(),
    sessionStats: async () => ({
      dictionaries: (await window.gloss.listDictionaries()).length,
      cachedLookups: lookup.cacheSize(),
      recents: (await window.gloss.getRecents()).length,
    }),
    clearLookupCache: () => lookup.clearCache(),
  });

  selection.attach(refs.pages(), (raw, rect) => lookup.lookupSelection(raw, rect));

  wireToolbar();
  wireViewerEvents();
  wireKeyboard();
  wireDragAndDrop();
  wireWheelZoom();

  sidebar.setTab(app.prefs.sidebarTab);
  if (app.prefs.sidebarVisible) sidebar.setVisible(true);

  await refreshSourceChips();
  await renderEmptyState();

  window.gloss.onOpenFile(handleOpenResult);
  window.gloss.onCommand(handleCommand);

  window.addEventListener('resize', debounce(() => viewer.handleResize(), 180));
  document.body.dataset.ready = '1';

  // Listeners are live — main may now deliver a queued document.
  await window.gloss.notifyReady();
})();

// ── Preferences / theme ───────────────────────────────────────────────────────

async function applyPrefs(delta) {
  app.prefs = await window.gloss.setPrefs(delta);
  applyTheme(app.prefs.theme);
  lookup.setPrefs(app.prefs);
  await refreshSourceChips();
}

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
}

/** Toolbar chips showing which sources are active. */
async function refreshSourceChips() {
  const dicts = await window.gloss.listDictionaries();
  const chips = $('source-chips');
  const parts = dicts.map(d => `
    <button class="chip${d.enabled ? '' : ' chip--off'}" data-chip-path="${esc(d.path)}"
            title="${esc(d.name)} — click to ${d.enabled ? 'disable' : 'enable'}"
            aria-pressed="${d.enabled}">${esc(d.name)}</button>`);
  parts.push(`
    <button class="chip chip--wiki${app.prefs.wikipediaEnabled ? '' : ' chip--off'}" data-chip-wiki="1"
            title="Wikipedia (${esc(app.prefs.wikipediaLang)}) — click to ${app.prefs.wikipediaEnabled ? 'disable' : 'enable'}"
            aria-pressed="${app.prefs.wikipediaEnabled}">Wikipedia</button>`);
  if (dicts.length === 0) {
    parts.unshift('<span class="chip-hint">No dictionaries</span>');
  }
  chips.innerHTML = parts.join('');
}

$('source-chips').addEventListener('click', async (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  if (chip.dataset.chipWiki) {
    await applyPrefs({ wikipediaEnabled: !app.prefs.wikipediaEnabled });
  } else {
    await window.gloss.toggleDictionary(chip.dataset.chipPath);
    lookup.invalidateDictionaries();
    await refreshSourceChips();
  }
});

// ── Empty state / recents ─────────────────────────────────────────────────────

async function renderEmptyState() {
  const recents = await window.gloss.getRecents();
  const list = $('recent-list');
  if (recents.length === 0) {
    list.innerHTML = '';
    return;
  }
  list.innerHTML = `
    <p class="recent-heading">Recent</p>
    ${recents.map(r => `
      <button class="recent-item${r.exists ? '' : ' recent-item--missing'}"
              data-recent="${esc(r.path)}" ${r.exists ? '' : 'disabled'}
              title="${esc(r.path)}">
        ${icons.doc}<span class="recent-name">${esc(r.name)}</span>
        ${r.exists ? '' : '<span class="recent-missing">missing</span>'}
      </button>`).join('')}`;
}

$('recent-list').addEventListener('click', async (e) => {
  const item = e.target.closest('[data-recent]');
  if (!item) return;
  handleOpenResult(await window.gloss.openRecent(item.dataset.recent));
});

// ── Opening documents ─────────────────────────────────────────────────────────

async function openViaDialog() {
  handleOpenResult(await window.gloss.openPdfDialog());
}

async function handleOpenResult(result) {
  if (!result || result.code === 'canceled') return;
  if (!result.ok) {
    toast(result.message || 'The document could not be opened.', { long: true });
    return;
  }

  setLoading(true);
  const opened = await viewer.openDocument(result.data, {
    name: result.name,
    path: result.path,
    restore: result.state,
    requestPassword: requestPassword,
  });
  setLoading(false);

  if (!opened.ok) {
    // The current document is untouched when an open fails, so leave the
    // title, controls and reading position exactly as they were.
    if (opened.code === 'password_canceled' || opened.code === 'superseded') return;
    toast(opened.message, { long: true });
    return;
  }

  app.docPath = result.path;
  app.docName = result.name;
  document.title = `${result.name} — Gloss`;
  hide(refs.emptyState());
  search.resetForNewDocument();
  hideBanner();
  announce(`Opened ${result.name}, ${viewer.pageCount()} pages`);
  await window.gloss.confirmOpen(result.path); // now it may enter recents
  await renderEmptyState();                    // keep the recent list current
}

function setLoading(loading) {
  const el = $('loading-indicator');
  if (loading) show(el); else hide(el);
}

// ── Password flow ─────────────────────────────────────────────────────────────

function requestPassword(retry) {
  return new Promise((resolve) => {
    const overlay = refs.passwordOverlay();
    const input = $('password-input');
    const error = $('password-error');
    app.passwordResolve = resolve;
    input.value = '';
    error.hidden = !retry;
    show(overlay);
    input.focus();
  });
}

function resolvePassword(value) {
  const resolve = app.passwordResolve;
  app.passwordResolve = null;
  hide(refs.passwordOverlay());
  resolve?.(value);
}

$('password-form').addEventListener('submit', (e) => {
  e.preventDefault();
  resolvePassword($('password-input').value);
});
$('password-cancel').addEventListener('click', () => resolvePassword(null));

// ── Document banner (scanned / garbled text) ──────────────────────────────────

function showBanner(message) {
  const banner = refs.docBanner();
  banner.querySelector('.banner-text').textContent = message;
  show(banner);
}
function hideBanner() { hide(refs.docBanner()); }
$('banner-dismiss').addEventListener('click', hideBanner);

// ── Toolbar ───────────────────────────────────────────────────────────────────

function wireToolbar() {
  $('btn-open').addEventListener('click', openViaDialog);
  $('btn-sidebar').addEventListener('click', () => sidebar.toggle());
  $('btn-search').addEventListener('click', () => search.openSearch());
  $('btn-prefs').addEventListener('click', () => prefsModal.open());
  $('btn-zoom-in').addEventListener('click', () => viewer.zoomIn());
  $('btn-zoom-out').addEventListener('click', () => viewer.zoomOut());
  $('btn-prev-page').addEventListener('click', () => viewer.goToPage(viewer.currentPage() - 1));
  $('btn-next-page').addEventListener('click', () => viewer.goToPage(viewer.currentPage() + 1));
  $('open-pdf-cta').addEventListener('click', openViaDialog);

  $('zoom-menu').addEventListener('change', (e) => {
    const value = e.target.value;
    if (value === 'fit-width' || value === 'fit-page') viewer.setZoom(value);
    else viewer.setZoom('custom', Number(value));
  });

  const pageInput = refs.pageInput();
  pageInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const n = parseInt(pageInput.value, 10);
    if (Number.isFinite(n)) viewer.goToPage(n);
    pageInput.blur();
  });
  pageInput.addEventListener('blur', () => { pageInput.value = String(viewer.currentPage()); });
}

// ── Viewer events → UI + persistence ──────────────────────────────────────────

const persistState = debounce(() => {
  if (!app.docPath) return;
  window.gloss.updateDocState(app.docPath, {
    page: viewer.currentPage(),
    zoomMode: viewer.zoomMode(),
    zoomScale: viewer.zoomScale(),
    scrollFraction: viewer.scrollFraction(),
  });
}, STATE_SAVE_DEBOUNCE_MS);

function wireViewerEvents() {
  viewer.on('documentopened', ({ total }) => {
    refs.pageInput().value = '1';
    refs.pageInput().max = String(total);
    refs.pageTotal().textContent = `of ${total}`;
    $('viewer-controls').hidden = false;
  });

  viewer.on('pagechanged', (n) => {
    if (document.activeElement !== refs.pageInput()) refs.pageInput().value = String(n);
    persistState();
  });

  viewer.on('zoomchanged', ({ mode, scale }) => {
    const menu = $('zoom-menu');
    menu.value = mode === 'custom' ? 'custom' : mode;
    const customOption = $('zoom-custom-option');
    if (mode === 'custom') {
      customOption.hidden = false;
      customOption.value = String(scale);
      customOption.textContent = `${Math.round(scale * 100)}%`;
      menu.value = String(scale);
    } else {
      customOption.hidden = true;
    }
    persistState();
  });

  viewer.on('textquality', (quality) => {
    if (quality === 'empty') {
      showBanner('This document has no selectable text — it looks like a scan. Reading works, but search and lookup need text.');
    } else if (quality === 'garbled') {
      showBanner('This PDF’s text mapping is incomplete, so extracted text may be wrong. Search and lookup may not work here.');
    }
  });

  refs.container().addEventListener('scroll', persistState, { passive: true });
}

// ── Drag and drop ─────────────────────────────────────────────────────────────

function wireDragAndDrop() {
  const zone = document.body;
  let depth = 0;
  const overlay = $('drop-overlay');

  zone.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    if (++depth === 1) show(overlay);
  });
  zone.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  zone.addEventListener('dragleave', () => {
    if (--depth <= 0) { depth = 0; hide(overlay); }
  });
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    hide(overlay);
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    handleOpenResult(await window.gloss.openDroppedPdf(file));
  });
}

// ── Ctrl + wheel zoom ─────────────────────────────────────────────────────────

function wireWheelZoom() {
  refs.container().addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !viewer.hasDocument()) return;
    e.preventDefault();
    const anchor = { x: e.clientX, y: e.clientY };
    if (e.deltaY < 0) viewer.zoomIn(anchor); else viewer.zoomOut(anchor);
  }, { passive: false });
}

// ── Keyboard: one dispatcher, explicit layer order ────────────────────────────

function inTextField(target) {
  return target instanceof HTMLElement &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
}

/** Escape closes exactly one layer, topmost first. */
function handleEscape() {
  if (isShown(refs.passwordOverlay())) { resolvePassword(null); return true; }
  if (prefsModal.isOpen()) { prefsModal.close(); return true; }
  if (search.isActive()) { search.closeSearch(); return true; }
  if (popup.isOpen()) { popup.closePopup({ force: true }); return true; }
  if (app.readMode) { window.gloss.setReadMode(false); return true; }
  return false;
}

function wireKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (handleEscape()) e.preventDefault();
      return;
    }

    const editing = inTextField(e.target);
    const accel = e.ctrlKey || e.metaKey;

    // Zoom keys are matched on e.code: the character produced by Shift+0
    // and by +/- varies across keyboard layouts, the physical key does not.
    if (accel && !e.altKey) {
      if (e.code === 'Digit0' || e.code === 'Numpad0') {
        e.preventDefault();
        viewer.setZoom(e.shiftKey ? 'fit-page' : 'fit-width');
        return;
      }
      if (!e.shiftKey) {
        if (e.code === 'Equal' || e.code === 'NumpadAdd' || e.key === '+') {
          e.preventDefault(); viewer.zoomIn(); return;
        }
        if (e.code === 'Minus' || e.code === 'NumpadSubtract' || e.key === '-') {
          e.preventDefault(); viewer.zoomOut(); return;
        }
        switch (e.key.toLowerCase()) {
          case 'f': e.preventDefault(); search.openSearch(); return;
          case 'o': e.preventDefault(); openViaDialog(); return;
          case 'd': e.preventDefault(); defineSelection(); return;
          case ',': e.preventDefault(); prefsModal.open(); return;
          default: break;
        }
      }
    }

    if (editing) return;

    if (e.key === 'F9') { e.preventDefault(); sidebar.toggle(); return; }
    if (e.key === 'F11') { e.preventDefault(); window.gloss.setReadMode(!app.readMode); return; }
    if (!viewer.hasDocument()) return;

    const container = refs.container();
    const behavior = scrollBehavior();
    switch (e.key) {
      case 'PageDown':
      case ' ':
        e.preventDefault();
        container.scrollBy({ top: container.clientHeight * 0.92, behavior });
        break;
      case 'PageUp':
        e.preventDefault();
        container.scrollBy({ top: -container.clientHeight * 0.92, behavior });
        break;
      case 'Home':
        e.preventDefault();
        container.scrollTo({ top: 0, behavior });
        break;
      case 'End':
        e.preventDefault();
        container.scrollTo({ top: container.scrollHeight, behavior });
        break;
      case 'ArrowRight':
        e.preventDefault(); viewer.goToPage(viewer.currentPage() + 1); break;
      case 'ArrowLeft':
        e.preventDefault(); viewer.goToPage(viewer.currentPage() - 1); break;
      default: break;
    }
  });
}

function defineSelection() {
  if (!selection.defineCurrentSelection()) {
    toast('Select a word in the document first.');
  }
}

// ── Commands from the application menu ────────────────────────────────────────

function handleCommand({ name, arg }) {
  switch (name) {
    case 'open': openViaDialog(); break;
    case 'openRecent': window.gloss.openRecent(arg).then(handleOpenResult); break;
    case 'clearRecents': window.gloss.clearRecents().then(renderEmptyState); break;
    case 'addDictionaries':
      window.gloss.addDictionaries().then(async () => {
        lookup.invalidateDictionaries();
        await refreshSourceChips();
      });
      break;
    case 'prefs': prefsModal.open(); break;
    case 'search': search.openSearch(); break;
    case 'define': defineSelection(); break;
    case 'sidebar': sidebar.toggle(); break;
    case 'zoomIn': viewer.zoomIn(); break;
    case 'zoomOut': viewer.zoomOut(); break;
    case 'fitWidth': viewer.setZoom('fit-width'); break;
    case 'fitPage': viewer.setZoom('fit-page'); break;
    case 'readMode': setReadMode(arg); break;
    default: break;
  }
}

function setReadMode(on) {
  app.readMode = !!on;
  document.body.classList.toggle('read-mode', app.readMode);
  viewer.handleResize();
}
