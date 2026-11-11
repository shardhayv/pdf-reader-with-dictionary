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
import * as links from './links.js';
import * as search from './search.js';
import * as sidebar from './sidebar.js';
import * as prefsModal from './prefsModal.js';

const STATE_SAVE_DEBOUNCE_MS = 700;

const app = {
  prefs: null,
  docPath: null,
  docName: null,
  docSize: 0,
  readMode: false,
  passwordResolve: null,
};

// ── Recovery boundary / boot ──────────────────────────────────────────────────

let lastUnexpectedNotice = 0;
let lastStateSaveNotice = 0;
let lastStorageNotice = 0;

function logActionFailure(context, error) {
  console.error(`Gloss ${context}:`, error);
}

function actionFailed(context, error, message) {
  logActionFailure(context, error);
  toast(message, { long: true });
}

function reportUnexpected(error, { fatal = false } = {}) {
  console.error('Gloss unexpected error:', error);
  const message = fatal
    ? 'Gloss could not finish starting. Your PDFs and glossaries were not changed.'
    : 'Something went wrong, but your document is still open. Try that action again.';

  if (fatal) {
    document.body.dataset.ready = 'error';
    setLoading(false);
    const empty = refs.emptyState();
    show(empty);
    empty.querySelector('.empty-title').textContent = 'Gloss needs a restart.';
    empty.querySelector('.empty-sub').textContent = message;
    const restart = $('open-pdf-cta');
    restart.textContent = 'Restart Gloss';
    // Capture beats the normal "Open PDF" listener if boot failed after the
    // toolbar was wired. One click must do exactly one thing: restart.
    restart.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      window.location.reload();
    }, { capture: true, once: true });
    announce(message);
    return;
  }

  // A burst of rejected promises should produce one calm notice, not a wall of
  // identical toasts. Details remain in the console for diagnosis.
  const now = Date.now();
  if (now - lastUnexpectedNotice > 2000) toast(message, { long: true });
  lastUnexpectedNotice = now;
}

window.addEventListener('error', event => reportUnexpected(event.error || event.message));
window.addEventListener('unhandledrejection', event => {
  event.preventDefault();
  reportUnexpected(event.reason);
});

async function boot() {
  app.prefs = await window.gloss.getPrefs();
  applyTheme(app.prefs.theme, app.prefs.pageTone);
  lookup.setPrefs(app.prefs);

  /** Single route to the system browser, shared by popup and PDF links. */
  async function openExternalLink(url) {
    try {
      const result = await window.gloss.openExternal(url);
      if (!result?.ok) throw new Error(result?.message || 'System link handler refused the URL');
    } catch (error) {
      actionFailed('could not open an external link', error, 'That link could not be opened.');
    }
  }

  popup.init({
    onEntryLookup: (word) => lookup.lookupEntry(word),
    onExternalOpen: openExternalLink,
    isWordSaved: (word) => (app.prefs?.savedWords || []).some(w => w.word.toLowerCase() === String(word).toLowerCase()),
    onToggleSaveWord: toggleSavedWord,
  });
  search.init();
  sidebar.init({
    onVisibilityChange: (visible) => window.gloss.setPrefs({ sidebarVisible: visible })
      .catch(error => logActionFailure('could not save the sidebar preference', error)),
    onTabChange: (tab) => window.gloss.setPrefs({ sidebarTab: tab })
      .catch(error => logActionFailure('could not save the sidebar tab preference', error)),
    getSavedWords: () => app.prefs?.savedWords || [],
    onRemoveSavedWord: removeSavedWordAt,
    onLookupSavedWord: (word) => {
      const container = refs.container();
      const rect = container.getBoundingClientRect();
      lookup.lookupSelection(word, {
        top: rect.top + 80,
        bottom: rect.top + 100,
        left: rect.left + Math.min(280, rect.width / 3),
        right: rect.left + Math.min(340, rect.width / 2),
      });
    },
    onExportSavedWords: exportSavedWordsMarkdown,
  });
  prefsModal.init({
    getPrefs: () => app.prefs,
    applyPrefs: applyPrefs,
    onDictsChanged: async () => {
      lookup.invalidateDictionaries();
      await refreshSourceChips();
    },
    onRecentsCleared: () => renderEmptyState().catch(error =>
      logActionFailure('could not refresh recent documents', error)),
    sessionStats: async () => ({
      dictionaries: (await window.gloss.listDictionaries()).length,
      cachedLookups: lookup.cacheSize(),
      recents: (await window.gloss.getRecents()).length,
    }),
    clearLookupCache: () => lookup.clearCache(),
  });

  selection.attach(refs.pages(), (raw, rect) => lookup.lookupSelection(raw, rect));
  links.attach(refs.pages(), {
    openExternal: openExternalLink,
    onError: (message) => toast(message),
  });

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
  window.gloss.onDictionariesChanged(({ failed = [], warnings = [] } = {}) => {
    lookup.invalidateDictionaries();
    refreshSourceChips().catch(error =>
      logActionFailure('could not refresh restored lookup sources', error));
    const notices = [];
    if (failed.length > 0) {
      const names = failed.slice(0, 3).map(item => item.name).join(', ');
      notices.push(`Could not restore ${names}. Add or reload ${failed.length === 1 ? 'it' : 'them'} in Preferences.`);
    }
    if (warnings.length > 0) {
      notices.push(warnings[0].message || 'Gloss recovered from unreadable saved state.');
    }
    if (notices.length > 0) toast(notices.join(' '), { long: true });
  });
  window.gloss.onStorageError(({ message } = {}) => {
    const now = Date.now();
    if (now - lastStorageNotice > 30_000) {
      toast(message || 'Gloss could not save its current state.', { long: true });
      lastStorageNotice = now;
    }
  });

  window.addEventListener('resize', debounce(() => viewer.handleResize(), 180));
  document.body.dataset.ready = '1';

  // Listeners are live — main may now deliver a queued document.
  await window.gloss.notifyReady();
}

boot().catch(error => reportUnexpected(error, { fatal: true }));

// ── Preferences / theme ───────────────────────────────────────────────────────

const PAGE_TONE_ORDER = ['original', 'warm', 'sepia', 'dark'];
const PAGE_TONE_LABELS = {
  original: 'Original white',
  warm: 'Warm paper',
  sepia: 'Sepia',
  dark: 'Night page',
};

async function applyPrefs(delta) {
  app.prefs = await window.gloss.setPrefs(delta);
  applyTheme(app.prefs.theme, app.prefs.pageTone);
  lookup.setPrefs(app.prefs);
  await refreshSourceChips();
}

function applyTheme(theme, pageTone = app.prefs?.pageTone || 'original') {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
  const tone = PAGE_TONE_ORDER.includes(pageTone) ? pageTone : 'original';
  if (tone === 'original') {
    delete document.documentElement.dataset.pageTone;
  } else {
    document.documentElement.dataset.pageTone = tone;
  }
  const toneBtn = $('btn-page-tone');
  if (toneBtn) {
    const label = PAGE_TONE_LABELS[tone] || 'Original white';
    toneBtn.title = `Page paper tint: ${label} (Ctrl+Shift+D)`;
    toneBtn.setAttribute('aria-pressed', String(tone !== 'original'));
  }
}

async function cyclePageTone() {
  const current = app.prefs?.pageTone || 'original';
  const next = PAGE_TONE_ORDER[(PAGE_TONE_ORDER.indexOf(current) + 1) % PAGE_TONE_ORDER.length];
  try {
    await applyPrefs({ pageTone: next });
    announce(`Page paper tint: ${PAGE_TONE_LABELS[next]}`);
  } catch (error) {
    actionFailed('could not change page appearance', error, 'Page appearance could not be changed.');
  }
}

async function toggleSavedWord({ word, definition, source }) {
  const cleanWord = String(word || '').trim();
  if (!cleanWord) return;
  const current = Array.isArray(app.prefs?.savedWords) ? [...app.prefs.savedWords] : [];
  const existingIdx = current.findIndex(item => item.word.toLowerCase() === cleanWord.toLowerCase());
  if (existingIdx >= 0) {
    current.splice(existingIdx, 1);
    await applyPrefs({ savedWords: current });
    sidebar.refreshSavedPanel();
    toast(`Removed “${cleanWord}” from vocabulary`);
  } else {
    current.unshift({
      word: cleanWord,
      definition: String(definition || '').trim().slice(0, 1000),
      source: String(source || '').trim().slice(0, 120),
      docName: app.docName || '',
      page: viewer.hasDocument() ? viewer.currentPage() : null,
      savedAt: Date.now(),
    });
    await applyPrefs({ savedWords: current.slice(0, 500) });
    sidebar.refreshSavedPanel();
    toast(`Saved “${cleanWord}” to vocabulary`);
  }
}

async function removeSavedWordAt(index) {
  const current = Array.isArray(app.prefs?.savedWords) ? [...app.prefs.savedWords] : [];
  if (index < 0 || index >= current.length) return;
  current.splice(index, 1);
  await applyPrefs({ savedWords: current });
  sidebar.refreshSavedPanel();
  popup.syncSaveState();
}

async function exportSavedWordsMarkdown() {
  const words = app.prefs?.savedWords || [];
  if (words.length === 0) return;
  const lines = [
    '# Gloss Vocabulary Notebook',
    '',
    ...words.map(w => {
      const meta = [w.source, w.docName ? `${w.docName}${w.page ? ` (p. ${w.page})` : ''}` : '']
        .filter(Boolean).join(' · ');
      return `- **${w.word}**${meta ? ` *(${meta})*` : ''}: ${w.definition || '—'}`;
    }),
  ];
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    toast(`Copied ${words.length} vocabulary ${words.length === 1 ? 'entry' : 'entries'} as Markdown`);
  } catch {
    toast('Could not copy vocabulary to clipboard.');
  }
}

/** Toolbar chips showing which sources are active. */
async function refreshSourceChips() {
  const dicts = await window.gloss.listDictionaries();
  const chips = $('source-chips');
  // Keep other books' glossaries loaded without letting them clutter or
  // influence the document currently being read.
  const visible = dicts.filter(d => d.applicable);
  const parts = visible.map(d => `
    <button class="chip${d.enabled ? '' : ' chip--off'}" data-chip-path="${esc(d.path)}"
            title="${esc(d.name)} — click to ${d.enabled ? 'disable' : 'enable'}"
            aria-pressed="${d.enabled}">${esc(d.name)}</button>`);
  parts.push(`
    <button class="chip chip--wikt${app.prefs.wiktionaryEnabled ? '' : ' chip--off'}" data-chip-wikt="1"
            title="Wiktionary — word meanings; click to ${app.prefs.wiktionaryEnabled ? 'disable' : 'enable'}"
            aria-pressed="${app.prefs.wiktionaryEnabled}">Wiktionary</button>
    <button class="chip chip--wiki${app.prefs.wikipediaEnabled ? '' : ' chip--off'}" data-chip-wiki="1"
            title="Wikipedia (${esc(app.prefs.wikipediaLang)}) — click to ${app.prefs.wikipediaEnabled ? 'disable' : 'enable'}"
            aria-pressed="${app.prefs.wikipediaEnabled}">Wikipedia</button>`);
  if (visible.length === 0) {
    parts.unshift('<span class="chip-hint">No local dictionaries</span>');
  }
  chips.innerHTML = parts.join('');
}

$('source-chips').addEventListener('click', async (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  chip.disabled = true;
  try {
    if (chip.dataset.chipWikt) {
      await applyPrefs({ wiktionaryEnabled: !app.prefs.wiktionaryEnabled });
    } else if (chip.dataset.chipWiki) {
      await applyPrefs({ wikipediaEnabled: !app.prefs.wikipediaEnabled });
    } else {
      const result = await window.gloss.toggleDictionary(chip.dataset.chipPath);
      if (!result?.success) throw new Error('Dictionary is no longer loaded');
      lookup.invalidateDictionaries();
      await refreshSourceChips();
    }
  } catch (error) {
    actionFailed('could not change a lookup source', error,
      'That lookup source could not be changed. Your current settings were kept.');
    await refreshSourceChips().catch(() => {});
  } finally {
    // refreshSourceChips normally replaces this node; this covers a failed
    // refresh so the control never remains permanently disabled.
    if (chip.isConnected) chip.disabled = false;
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
  item.disabled = true;
  try {
    await handleOpenResult(await window.gloss.openRecent(item.dataset.recent));
  } catch (error) {
    actionFailed('could not open a recent PDF', error,
      'That recent PDF could not be opened. Your current document was kept.');
  } finally {
    if (item.isConnected) item.disabled = false;
  }
});

// ── Opening documents ─────────────────────────────────────────────────────────

async function openViaDialog() {
  try {
    await handleOpenResult(await window.gloss.openPdfDialog());
  } catch (error) {
    actionFailed('could not show or complete the PDF picker', error,
      'The PDF picker failed. Your current document was kept.');
  }
}

async function handleOpenResult(result) {
  if (!result || result.code === 'canceled') return;
  if (!result.ok) {
    toast(result.message || 'The document could not be opened.', { long: true });
    return;
  }

  // A second-instance or file-manager request may arrive while another PDF
  // is waiting for a password. Resolve that old prompt as cancelled before
  // starting the new candidate.
  if (app.passwordResolve) resolvePassword(null);

  let opened;
  setLoading(true);
  try {
    opened = await viewer.openDocument(result.data, {
      name: result.name,
      path: result.path,
      restore: result.state,
      requestPassword: requestPassword,
    });
  } catch (error) {
    actionFailed('PDF renderer failed unexpectedly', error,
      'Gloss could not display that PDF. Your current document was kept.');
    return;
  } finally {
    setLoading(false);
  }

  if (!opened.ok) {
    // The current document is untouched when an open fails, so leave the
    // title, controls and reading position exactly as they were.
    if (opened.code === 'password_canceled' || opened.code === 'superseded') return;
    toast(opened.message, { long: true });
    return;
  }

  app.docPath = result.path;
  app.docName = result.name;
  app.docSize = result.size || 0;
  document.title = `${result.name} — Gloss`;
  hide(refs.emptyState());
  search.resetForNewDocument();
  hideBanner();
  announce(`Opened ${result.name}, ${viewer.pageCount()} pages`);
  try {
    const confirmed = await window.gloss.confirmOpen(result.path, viewer.documentFingerprint());
    if (!confirmed?.ok) throw new Error('The main process did not confirm the open document');
  } catch (error) {
    // Rendering succeeded. Do not undo it merely because session persistence
    // failed; explain only the consequence that matters to the reader.
    actionFailed('could not save the open document state', error,
      'The PDF is open, but Gloss may not remember this reading position next time.');
  }
  lookup.invalidateDictionaries();             // active book glossary may change
  await refreshSourceChips().catch(error =>
    logActionFailure('could not refresh lookup sources after opening a PDF', error));
  await renderEmptyState().catch(error =>
    logActionFailure('could not refresh recents after opening a PDF', error));
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

// ── Document properties modal ─────────────────────────────────────────────────

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatPageDimensions(widthPt, heightPt) {
  if (!widthPt || !heightPt) return '—';
  const wMm = Math.round((widthPt / 72) * 25.4);
  const hMm = Math.round((heightPt / 72) * 25.4);
  const wIn = (widthPt / 72).toFixed(2);
  const hIn = (heightPt / 72).toFixed(2);
  return `${wMm} × ${hMm} mm (${wIn} × ${hIn} in)`;
}

async function openDocInfoModal() {
  if (!viewer.hasDocument()) {
    toast('Open a PDF first to view its properties.');
    return;
  }
  const overlay = $('doc-info-overlay');
  const body = $('doc-info-body');
  const closeBtn = $('doc-info-close');
  if (!overlay || !body) return;
  closeBtn.innerHTML = icons.close;
  const meta = await viewer.getDocumentMetadata();
  if (!meta) return;

  const row = (label, value) => `
    <div class="doc-info-row">
      <dt>${esc(label)}</dt>
      <dd>${esc(value || '—')}</dd>
    </div>`;

  body.innerHTML = `
    <dl class="doc-info-list">
      ${row('File name', app.docName)}
      ${row('Location', app.docPath)}
      ${row('File size', formatBytes(app.docSize))}
      ${row('Title', meta.title)}
      ${row('Author', meta.author)}
      ${row('Subject', meta.subject)}
      ${row('Creator', meta.creator)}
      ${row('Producer', meta.producer)}
      ${row('PDF version', meta.pdfVersion ? `PDF ${meta.pdfVersion}${meta.linearized ? ' (Fast Web View)' : ''}` : '')}
      ${row('Pages', String(meta.pages))}
      ${row('Page size', formatPageDimensions(meta.widthPt, meta.heightPt))}
      ${meta.rotation ? row('Rotation', `${meta.rotation}°`) : ''}
    </dl>
    <div class="prefs-actions">
      <button type="button" class="btn" id="doc-info-copy-path">${icons.copy}Copy file path</button>
    </div>`;

  $('doc-info-copy-path')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(app.docPath || '');
      toast('Copied file path');
    } catch {
      toast('Could not copy file path.');
    }
  });

  show(overlay);
  closeBtn.focus();
}

function closeDocInfoModal() {
  const overlay = $('doc-info-overlay');
  if (overlay && isShown(overlay)) hide(overlay);
}

$('doc-info-close')?.addEventListener('click', closeDocInfoModal);
$('doc-info-overlay')?.addEventListener('pointerdown', (e) => {
  if (e.target === $('doc-info-overlay')) closeDocInfoModal();
});

// ── Toolbar ───────────────────────────────────────────────────────────────────

function wireToolbar() {
  $('btn-open').addEventListener('click', openViaDialog);
  $('btn-sidebar').addEventListener('click', () => sidebar.toggle());
  $('btn-search').addEventListener('click', () => search.openSearch());
  $('btn-prefs').addEventListener('click', () => prefsModal.open());
  $('btn-zoom-in').addEventListener('click', () => viewer.zoomIn());
  $('btn-zoom-out').addEventListener('click', () => viewer.zoomOut());
  $('btn-rotate').addEventListener('click', (e) => viewer.rotateBy(e.shiftKey ? -90 : 90));
  $('btn-spread')?.addEventListener('click', () => viewer.toggleSpreadMode());
  $('btn-bookmark')?.addEventListener('click', () => {
    const added = viewer.toggleBookmark();
    toast(added ? `Bookmarked page ${viewer.currentPage()}` : `Removed bookmark on page ${viewer.currentPage()}`);
  });
  $('btn-page-tone').addEventListener('click', cyclePageTone);
  $('btn-doc-info').addEventListener('click', openDocInfoModal);
  $('btn-history-back').addEventListener('click', () => viewer.goBack());
  $('btn-history-forward').addEventListener('click', () => viewer.goForward());
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
    if (Number.isFinite(n)) viewer.goToPage(n, { recordHistory: true });
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
    rotation: viewer.rotation(),
    spreadMode: viewer.spreadMode(),
    bookmarks: viewer.bookmarks(),
  }).catch(error => {
    logActionFailure('could not save reading position', error);
    const now = Date.now();
    if (now - lastStateSaveNotice > 30_000) {
      toast('Gloss could not save your reading position.', { long: true });
      lastStateSaveNotice = now;
    }
  });
}, STATE_SAVE_DEBOUNCE_MS);

function updateReadingProgress() {
  const bar = $('reading-progress');
  const fill = $('reading-progress-fill');
  if (!bar || !fill) return;
  if (!viewer.hasDocument()) {
    hide(bar);
    return;
  }
  show(bar);
  const total = viewer.pageCount();
  const ratio = total <= 1 ? 1 : Math.max(viewer.scrollFraction(), viewer.currentPage() / total);
  fill.style.transform = `scaleX(${Math.max(0, Math.min(1, ratio))})`;
}

function wireViewerEvents() {
  viewer.on('documentopened', ({ total }) => {
    refs.pageInput().value = '1';
    refs.pageInput().max = String(total);
    refs.pageTotal().textContent = `of ${total}`;
    $('viewer-controls').hidden = false;
    updateReadingProgress();
  });

  const syncBookmarkBtn = () => {
    const btn = $('btn-bookmark');
    if (!btn) return;
    const active = viewer.hasDocument() && viewer.isBookmarked(viewer.currentPage());
    btn.setAttribute('aria-pressed', String(active));
    btn.title = active
      ? `Remove bookmark on page ${viewer.currentPage()} (Ctrl+B)`
      : `Bookmark page ${viewer.currentPage()} (Ctrl+B)`;
  };

  viewer.on('pagechanged', (n) => {
    if (document.activeElement !== refs.pageInput()) refs.pageInput().value = String(n);
    updateReadingProgress();
    syncBookmarkBtn();
    persistState();
  });

  viewer.on('rotationchanged', () => {
    persistState();
  });

  viewer.on('spreadchanged', (mode) => {
    const btn = $('btn-spread');
    if (btn) btn.setAttribute('aria-pressed', String(mode === 'two-page'));
    persistState();
  });

  viewer.on('bookmarkschanged', () => {
    syncBookmarkBtn();
    persistState();
  });

  viewer.on('historychanged', ({ canBack, canForward }) => {
    const backBtn = $('btn-history-back');
    const fwdBtn = $('btn-history-forward');
    if (backBtn) backBtn.hidden = !canBack;
    if (fwdBtn) fwdBtn.hidden = !canForward;
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

  refs.container().addEventListener('scroll', () => {
    updateReadingProgress();
    persistState();
  }, { passive: true });
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
    try {
      await handleOpenResult(await window.gloss.openDroppedPdf(file));
    } catch (error) {
      actionFailed('could not open a dropped PDF', error,
        'That dropped PDF could not be opened. Your current document was kept.');
    }
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
  if ($('doc-info-overlay') && isShown($('doc-info-overlay'))) { closeDocInfoModal(); return true; }
  if (prefsModal.isOpen()) { prefsModal.close(); return true; }
  if (search.isActive()) { search.closeSearch(); return true; }
  if (popup.isOpen()) { popup.closePopup({ force: true }); return true; }
  if (app.readMode) { requestReadMode(false); return true; }
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

    if (!editing && e.altKey && !accel && !e.shiftKey) {
      if (e.key === 'ArrowLeft') {
        if (viewer.goBack()) e.preventDefault();
        return;
      }
      if (e.key === 'ArrowRight') {
        if (viewer.goForward()) e.preventDefault();
        return;
      }
    }

    // Zoom keys are matched on e.code: the character produced by Shift+0
    // and by +/- varies across keyboard layouts, the physical key does not.
    if (accel && !e.altKey) {
      if (e.code === 'Digit0' || e.code === 'Numpad0') {
        e.preventDefault();
        viewer.setZoom(e.shiftKey ? 'fit-page' : 'fit-width');
        return;
      }
      if (e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        cyclePageTone();
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
          case 'b':
            if (viewer.hasDocument()) {
              e.preventDefault();
              const added = viewer.toggleBookmark();
              toast(added ? `Bookmarked page ${viewer.currentPage()}` : `Removed bookmark on page ${viewer.currentPage()}`);
            }
            return;
          case 'i': e.preventDefault(); openDocInfoModal(); return;
          case 'p': e.preventDefault(); if (viewer.hasDocument()) window.print(); return;
          case ',': e.preventDefault(); prefsModal.open(); return;
          default: break;
        }
      }
    }

    if (editing) return;

    if (e.key === 'F9') { e.preventDefault(); sidebar.toggle(); return; }
    if (e.key === 'F11') { e.preventDefault(); requestReadMode(!app.readMode); return; }
    if (!viewer.hasDocument()) return;

    if (!accel && !e.altKey) {
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        viewer.rotateBy(e.shiftKey ? -90 : 90);
        return;
      }
      if ((e.key === 'v' || e.key === 'V') && !e.shiftKey) {
        e.preventDefault();
        viewer.toggleSpreadMode();
        return;
      }
      if (popup.isOpen() && (e.key === 's' || e.key === 'S') && !e.shiftKey) {
        e.preventDefault();
        popup.toggleSaveCurrentWord();
        return;
      }
      if (popup.isOpen() && /^[1-9]$/.test(e.key)) {
        if (popup.selectTab(Number(e.key) - 1)) {
          e.preventDefault();
          return;
        }
      }
    }

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
    case 'openRecent':
      window.gloss.openRecent(arg).then(handleOpenResult).catch(error =>
        actionFailed('could not open a recent PDF from the menu', error,
          'That recent PDF could not be opened. Your current document was kept.'));
      break;
    case 'clearRecents':
      window.gloss.clearRecents().then(renderEmptyState).catch(error =>
        actionFailed('could not clear recent documents', error,
          'Recent documents could not be cleared.'));
      break;
    case 'addDictionaries':
      window.gloss.addDictionaries().then(async () => {
        lookup.invalidateDictionaries();
        await refreshSourceChips();
      }).catch(error =>
        actionFailed('could not add lookup sources', error,
          'Dictionaries could not be added. Existing sources were kept.'));
      break;
    case 'prefs': prefsModal.open(); break;
    case 'docInfo': openDocInfoModal(); break;
    case 'print': if (viewer.hasDocument()) window.print(); break;
    case 'search': search.openSearch(); break;
    case 'define': defineSelection(); break;
    case 'sidebar': sidebar.toggle(); break;
    case 'zoomIn': viewer.zoomIn(); break;
    case 'zoomOut': viewer.zoomOut(); break;
    case 'fitWidth': viewer.setZoom('fit-width'); break;
    case 'fitPage': viewer.setZoom('fit-page'); break;
    case 'rotateCw': viewer.rotateBy(90); break;
    case 'rotateCcw': viewer.rotateBy(-90); break;
    case 'toggleSpread': viewer.toggleSpreadMode(); break;
    case 'toggleBookmark':
      if (viewer.hasDocument()) {
        const added = viewer.toggleBookmark();
        toast(added ? `Bookmarked page ${viewer.currentPage()}` : `Removed bookmark on page ${viewer.currentPage()}`);
      }
      break;
    case 'cyclePageTone': cyclePageTone(); break;
    case 'historyBack': viewer.goBack(); break;
    case 'historyForward': viewer.goForward(); break;
    case 'readMode': setReadMode(arg); break;
    default: break;
  }
}

function setReadMode(on) {
  app.readMode = !!on;
  document.body.classList.toggle('read-mode', app.readMode);
  viewer.handleResize();
}

function requestReadMode(on) {
  window.gloss.setReadMode(on).catch(error =>
    actionFailed('could not change read mode', error, 'Read mode could not be changed.'));
}
