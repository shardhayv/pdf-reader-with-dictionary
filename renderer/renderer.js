/**
 * renderer.js
 * ES module — runs in Electron renderer with contextIsolation.
 * pdfjs-dist v4 API (TextLayer class).
 */

import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  new URL('../node_modules/pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href;

// ─── State ────────────────────────────────────────────────────────────────────
let pdfDoc             = null;
let currentPage        = 1;
let totalPages         = 0;
let pageObserver       = null;
let lazyObserver       = null;
let currentPrefs       = null;
let activePrefsSection = 'dictionaries';

// Read mode
let isReadMode      = false;

const visiblePages  = new Set();
const lookupCache   = new Map();
let   popupResults  = [];
let   popupWord     = '';

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const btnOpenPDF      = document.getElementById('btn-open-pdf');
const btnAddDict      = document.getElementById('btn-add-dict');
const btnPrefs        = document.getElementById('btn-prefs');
const btnReadMode     = document.getElementById('read-mode-btn');
const pageInfo        = document.getElementById('page-info');
const pageGoto        = document.getElementById('page-goto');
const emptyState      = document.getElementById('empty-state');
const popup           = document.getElementById('popup');
const popupClose      = document.getElementById('popup-close');
const popupContent    = document.getElementById('popup-content');
const dictBadges      = document.getElementById('dict-badges');
const prefsOverlay    = document.getElementById('prefs-overlay');
const prefsBody       = document.getElementById('prefs-body');
const readModeBar     = document.getElementById('read-mode-bar');
const readPageDisplay = document.getElementById('read-page-display');

// ─── Startup init ─────────────────────────────────────────────────────────────
(async () => {
  currentPrefs = await window.electronAPI.getPreferences();
  applyTheme(currentPrefs.theme);
  await refreshDictBadges();
})();

// ─── Open PDF ─────────────────────────────────────────────────────────────────
btnOpenPDF.addEventListener('click', async () => {
  const filePath = await window.electronAPI.openPDF();
  if (!filePath) return;
  const b64 = await window.electronAPI.readPDF(filePath);
  if (!b64) { alert('Could not read file.'); return; }

  try {
    const loadingTask = pdfjsLib.getDocument({ data: base64ToUint8Array(b64) });
    pdfDoc = await loadingTask.promise;
    totalPages  = pdfDoc.numPages;
    currentPage = 1;
    emptyState.style.display = 'none';
    pageGoto.max = totalPages;
    await renderAllPages(pdfDoc);
  } catch (err) {
    alert(err.name === 'PasswordException'
      ? 'This PDF is password-protected.'
      : 'Failed to open PDF: ' + err.message);
  }
});

// ─── Add Dictionary ───────────────────────────────────────────────────────────
btnAddDict.addEventListener('click', async () => {
  const paths = await window.electronAPI.openMDX();
  if (!paths || paths.length === 0) return;

  btnAddDict.disabled = true;
  const origLabel = btnAddDict.innerHTML;
  btnAddDict.innerHTML = `<span style="font-size:12px">Loading…</span>`;

  const results = await window.electronAPI.loadDictionaries(paths);
  const failed  = results.filter(r => !r.success && !r.alreadyLoaded);
  if (failed.length > 0) {
    alert('Failed to load:\n' + failed.map(f => `${f.name}: ${f.error}`).join('\n'));
  }

  lookupCache.clear();
  await refreshDictBadges();
  btnAddDict.disabled = false;
  btnAddDict.innerHTML = origLabel;
});

// ─── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  // Read mode: F11 toggle, Escape to exit
  if (e.key === 'F11') { e.preventDefault(); if (isReadMode) exitReadMode(); else enterReadMode(); return; }
  if (e.key === 'Escape' && isReadMode) { exitReadMode(); return; }

  // Scroll navigation (requires open PDF, not in an input)
  if (!pdfDoc || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const c = document.getElementById('pdf-container');
  if (e.key === 'PageDown') { e.preventDefault(); c.scrollBy({ top:  c.clientHeight * 0.9, behavior: 'smooth' }); }
  if (e.key === 'PageUp')   { e.preventDefault(); c.scrollBy({ top: -c.clientHeight * 0.9, behavior: 'smooth' }); }
  if (e.key === 'Home')     { e.preventDefault(); c.scrollTo({ top: 0, behavior: 'smooth' }); }
  if (e.key === 'End')      { e.preventDefault(); c.scrollTo({ top: c.scrollHeight, behavior: 'smooth' }); }
});

// ─── Go-to-page input ─────────────────────────────────────────────────────────
pageGoto.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const num = parseInt(pageGoto.value, 10);
  pageGoto.value = '';
  if (num >= 1 && num <= totalPages) goToPage(num);
});

function goToPage(num) {
  const wrapper = document.querySelector(`.pdf-page-wrapper[data-page-number="${num}"]`);
  if (wrapper) wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─── Render all pages: create placeholders, then lazy-render near viewport ────
async function renderAllPages(pdf) {
  pdfDoc = pdf;
  totalPages = pdf.numPages;

  const container = document.getElementById('pdf-container');
  closePopup();

  if (pageObserver) { pageObserver.disconnect(); pageObserver = null; }
  if (lazyObserver) { lazyObserver.disconnect(); lazyObserver = null; }
  visiblePages.clear();

  container.querySelectorAll('.pdf-page-wrapper').forEach(el => el.remove());
  container.scrollTop = 0;

  // Use page 1 dimensions to pre-size all placeholders (correct scrollbar height)
  const firstPage     = await pdf.getPage(1);
  const firstViewport = firstPage.getViewport({ scale: getScale(firstPage) });
  const estW = Math.floor(firstViewport.width);
  const estH = Math.floor(firstViewport.height);

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page-wrapper';
    wrapper.dataset.pageNumber = pageNum;
    wrapper.dataset.rendered = 'false';
    wrapper.style.width  = estW + 'px';
    wrapper.style.height = estH + 'px';

    const placeholder = document.createElement('div');
    placeholder.className = 'page-placeholder';
    placeholder.textContent = `Page ${pageNum}`;
    wrapper.appendChild(placeholder);

    container.appendChild(wrapper);
  }

  pageInfo.textContent = `Page 1 of ${totalPages}`;
  pageGoto.max = totalPages;

  setupPageObserver();
  setupLazyObserver();
}

// ─── Page-number tracking observer ────────────────────────────────────────────
function setupPageObserver() {
  const container = document.getElementById('pdf-container');
  pageObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      const n = parseInt(entry.target.dataset.pageNumber, 10);
      if (entry.isIntersecting) visiblePages.add(n); else visiblePages.delete(n);
    });
    if (visiblePages.size > 0) {
      currentPage = Math.min(...visiblePages);
      pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;
    }
  }, { root: container, threshold: 0.1 });

  document.querySelectorAll('.pdf-page-wrapper').forEach(w => pageObserver.observe(w));
}

// ─── Lazy render observer ──────────────────────────────────────────────────────
const RENDER_BUFFER   = 2;
const DESTROY_THRESHOLD = 5;

function setupLazyObserver() {
  const container = document.getElementById('pdf-container');
  lazyObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const pageNum = parseInt(entry.target.dataset.pageNumber, 10);
      for (let i = pageNum - RENDER_BUFFER; i <= pageNum + RENDER_BUFFER; i++) {
        if (i >= 1 && i <= totalPages) renderPage(i);
      }
      destroyFarPages(pageNum);
    });
  }, {
    root: container,
    rootMargin: '200px 0px 200px 0px',
    threshold: 0,
  });

  document.querySelectorAll('.pdf-page-wrapper').forEach(wrapper => {
    lazyObserver.observe(wrapper);
  });
}

// ─── Render a single page into its wrapper ────────────────────────────────────
async function renderPage(pageNum) {
  const wrapper = document.querySelector(
    `.pdf-page-wrapper[data-page-number="${pageNum}"]`
  );
  if (!wrapper || wrapper.dataset.rendered === 'true') return;
  wrapper.dataset.rendered = 'true';

  const page     = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: getScale(page) });
  const dpr      = window.devicePixelRatio || 1;

  wrapper.innerHTML = '';
  wrapper.style.width  = Math.floor(viewport.width)  + 'px';
  wrapper.style.height = Math.floor(viewport.height) + 'px';

  const canvas = document.createElement('canvas');
  canvas.width        = Math.floor(viewport.width  * dpr);
  canvas.height       = Math.floor(viewport.height * dpr);
  canvas.style.width  = Math.floor(viewport.width)  + 'px';
  canvas.style.height = Math.floor(viewport.height) + 'px';

  const textLayerDiv = document.createElement('div');
  textLayerDiv.className = 'pdf-text-layer';
  textLayerDiv.style.setProperty('--scale-factor', viewport.scale);

  wrapper.appendChild(canvas);
  wrapper.appendChild(textLayerDiv);

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  await page.render({ canvasContext: ctx, viewport }).promise;

  const textContent = await page.getTextContent();
  const textLayer = new pdfjsLib.TextLayer({
    textContentSource: textContent,
    container: textLayerDiv,
    viewport,
  });
  await textLayer.render();
}

// ─── Destroy canvas of pages far from viewport to free memory ─────────────────
function destroyFarPages(nearPage) {
  document.querySelectorAll('.pdf-page-wrapper[data-rendered="true"]').forEach(wrapper => {
    const pageNum = parseInt(wrapper.dataset.pageNumber, 10);
    if (Math.abs(pageNum - nearPage) > DESTROY_THRESHOLD) {
      const canvas = wrapper.querySelector('canvas');
      if (canvas) wrapper.style.height = canvas.offsetHeight + 'px';
      wrapper.innerHTML = '';
      wrapper.dataset.rendered = 'false';

      const placeholder = document.createElement('div');
      placeholder.className = 'page-placeholder';
      placeholder.textContent = `Page ${pageNum}`;
      wrapper.appendChild(placeholder);
    }
  });
}

function getScale(page) {
  const container = document.getElementById('pdf-container');
  const availableWidth = container.clientWidth - 48;
  const viewport = page.getViewport({ scale: 1 });
  return availableWidth / viewport.width;
}

// ─── Read mode ────────────────────────────────────────────────────────────────
function enterReadMode() {
  isReadMode = true;
  document.body.classList.add('read-mode');
  readPageDisplay.textContent = pageInfo.textContent;
  readModeBar.style.display = 'flex';
}

function exitReadMode() {
  isReadMode = false;
  document.body.classList.remove('read-mode');
  readModeBar.style.display = 'none';
}

btnReadMode.addEventListener('click', () => { if (isReadMode) exitReadMode(); else enterReadMode(); });
document.getElementById('exit-read-mode').addEventListener('click', exitReadMode);

// Keep read-mode page counter in sync with main page-info
new MutationObserver(() => {
  if (isReadMode) readPageDisplay.textContent = pageInfo.textContent;
}).observe(pageInfo, { childList: true, characterData: true, subtree: true });

// ─── Re-render on window resize ───────────────────────────────────────────────
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (pdfDoc) renderAllPages(pdfDoc); }, 300);
});

// ─── Double-click word lookup ─────────────────────────────────────────────────
document.addEventListener('dblclick', async e => {
  if (!e.target.closest('.pdf-text-layer')) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;
  const word = extractCleanWord(selection);
  if (!word || /^\d+$/.test(word)) return;
  await lookupAndShow(word, selection);
});

async function lookupAndShow(word, selection) {
  if (lookupCache.has(word)) {
    const c = lookupCache.get(word);
    showPopup(c.results, c.word, selection);
    return;
  }

  const prefs = currentPrefs || await window.electronAPI.getPreferences();

  // 1. All enabled MDX dictionaries in priority order
  const mdxHits = await window.electronAPI.lookupAll(word);
  const results = mdxHits.map(r => ({ source: 'mdx', ...r }));

  // 2. Wikipedia — always if no MDX hit, or always if not fallback-only
  if (prefs.wikipediaEnabled) {
    if (results.length === 0 || !prefs.wikipediaAsFallback) {
      const wiki = await window.electronAPI.lookupWikipedia(word);
      if (wiki) results.push({ source: 'wikipedia', found: true, word, ...wiki });
    }
  }

  lookupCache.set(word, { results, word });
  showPopup(results, word, selection);
}

// ─── Popup show / hide ────────────────────────────────────────────────────────
let hideTimer = null;

function showPopup(results, word, selection) {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }

  popupResults = results;
  popupWord    = word;
  popupContent.innerHTML = buildPopupHTML(results, word);
  popupContent.scrollTop = 0;

  popup.classList.remove('visible');
  popup.style.display = 'block';

  // Position relative to selected text
  const sel  = selection || window.getSelection();
  const rect = (sel && sel.rangeCount > 0)
    ? sel.getRangeAt(0).getBoundingClientRect()
    : { bottom: window.innerHeight / 2, top: window.innerHeight / 2 - 10, left: window.innerWidth / 2 };

  const pw = popup.offsetWidth  || 340;
  const ph = popup.offsetHeight || 220;

  let top  = rect.bottom + 10;
  let left = rect.left;
  if (top  + ph > window.innerHeight) top  = rect.top - ph - 10;
  if (left + pw > window.innerWidth)  left = window.innerWidth - pw - 10;
  if (left < 10) left = 10;
  if (top  < 10) top  = 10;

  popup.style.top  = top  + 'px';
  popup.style.left = left + 'px';
  requestAnimationFrame(() => popup.classList.add('visible'));
}

function closePopup() {
  if (!popup.classList.contains('visible')) return;
  popup.classList.remove('visible');
  hideTimer = setTimeout(() => {
    if (!popup.classList.contains('visible')) popup.style.display = 'none';
    hideTimer = null;
  }, 150);
}

popupClose.addEventListener('click', closePopup);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePopup(); });
document.addEventListener('mousedown', e => {
  if (popup.classList.contains('visible') && !popup.contains(e.target)) closePopup();
});

// ─── Selection-based lookup ───────────────────────────────────────────────────
document.addEventListener('mouseup', async e => {
  if (e.target.closest('#popup')) return;

  setTimeout(async () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;

    const raw = selection.toString().trim();
    if (!raw || raw.length < 2) return;

    let word = raw.split(/\s+/)[0];
    word = word.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, '').replace(/^-+|-+$/g, '').toLowerCase();
    if (!word || word.length < 2) return;

    await lookupAndShow(word, selection);
  }, 100);
});

// Delegated: tab switching + wiki link
popupContent.addEventListener('click', e => {
  const tab = e.target.closest('.popup-tab');
  if (tab) {
    const idx = parseInt(tab.dataset.tab, 10);
    popupContent.querySelectorAll('.popup-tab').forEach((t, i) => t.classList.toggle('active', i === idx));
    popupContent.querySelector('.popup-tab-content').innerHTML = buildResultHTML(popupResults[idx]);
    return;
  }
  const link = e.target.closest('.wiki-link');
  if (link) {
    e.preventDefault();
    if (link.dataset.url) window.electronAPI.openExternal(link.dataset.url);
  }
});

// ─── Popup HTML builders ──────────────────────────────────────────────────────
function buildPopupHTML(results, word) {
  const title = `<div class="popup-word">${escHtml(word)}</div>`;

  if (!results || results.length === 0) {
    return `${title}<div class="popup-not-found">No definition found for this word.</div>`;
  }

  if (results.length === 1) {
    return `${title}${buildResultHTML(results[0])}`;
  }

  // Multiple sources → tabs
  const tabs = results.map((r, i) => {
    const label = r.source === 'wikipedia' ? '📖 Wikipedia' : escHtml(r.dictName || 'Dictionary');
    return `<button class="popup-tab${i === 0 ? ' active' : ''}" data-tab="${i}">${label}</button>`;
  }).join('');

  return `
    ${title}
    <div class="popup-tabs-bar">${tabs}</div>
    <div class="popup-tab-content">${buildResultHTML(results[0])}</div>
  `;
}

function buildResultHTML(result) {
  if (result.source === 'wikipedia') {
    return `
      <span class="source-badge wikipedia">📖 Wikipedia</span>
      <p class="popup-extract">${escHtml(result.extract)}</p>
      <a class="wiki-link" href="#" data-url="${escHtml(result.url)}">Read more on Wikipedia →</a>
    `;
  }

  const def   = result.definition || '';
  const badge = `<span class="source-badge mdx">${escHtml(result.dictName || 'Dictionary')}</span>`;

  if (/<[a-z][\s\S]*>/i.test(def)) {
    return `${badge}<div class="popup-raw">${sanitizeHTML(def)}</div>`;
  }

  const lines = def.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (lines.length === 0) return `<div class="popup-not-found">No definition text.</div>`;

  const items = lines.map((line, i) =>
    `<li><span class="def-num">${i + 1}.</span><span>${escHtml(line.replace(/^\d+[.)]\s*/, ''))}</span></li>`
  ).join('');

  return `${badge}<ul class="popup-definitions">${items}</ul>`;
}

// ─── Dictionary badges ────────────────────────────────────────────────────────
async function refreshDictBadges() {
  const [dicts, prefs] = await Promise.all([
    window.electronAPI.listDictionaries(),
    window.electronAPI.getPreferences(),
  ]);
  currentPrefs = prefs;

  const mdxBadges = dicts.map(d => `
    <button class="dict-badge dict-badge--mdx${d.enabled ? '' : ' dict-badge--disabled'}"
            data-badge-path="${escHtml(d.path)}"
            title="${d.enabled ? 'Enabled' : 'Disabled'} — click to toggle">
      ${escHtml(d.name)}
    </button>`).join('');

  const wikiBadge = `
    <button class="dict-badge dict-badge--wiki${prefs.wikipediaEnabled ? '' : ' dict-badge--disabled'}"
            data-badge-wiki="1"
            title="${prefs.wikipediaEnabled ? 'Wikipedia enabled' : 'Wikipedia disabled'} — click to toggle">
      Wikipedia
    </button>`;

  dictBadges.innerHTML = dicts.length === 0 && !prefs.wikipediaEnabled
    ? '<span style="font-size:12px;color:var(--text-muted)">No dictionaries</span>'
    : mdxBadges + wikiBadge;
}

dictBadges.addEventListener('click', async e => {
  const badge = e.target.closest('.dict-badge');
  if (!badge) return;

  if (badge.dataset.badgeWiki) {
    const prefs = await window.electronAPI.getPreferences();
    await window.electronAPI.savePreferences({ wikipediaEnabled: !prefs.wikipediaEnabled });
  } else {
    await window.electronAPI.toggleDictionary(badge.dataset.badgePath);
  }
  lookupCache.clear();
  currentPrefs = await window.electronAPI.getPreferences();
  await refreshDictBadges();
});

// ─── Theme ────────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.setAttribute('data-theme', theme);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

// ─── Preferences modal ────────────────────────────────────────────────────────
btnPrefs.addEventListener('click', openPreferences);

document.getElementById('prefs-close').addEventListener('click', () => {
  prefsOverlay.style.display = 'none';
});
prefsOverlay.addEventListener('click', e => {
  if (e.target === prefsOverlay) prefsOverlay.style.display = 'none';
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && prefsOverlay.style.display !== 'none') prefsOverlay.style.display = 'none';
});

// Nav tabs inside modal
document.querySelector('.modal-nav').addEventListener('click', async e => {
  const btn = e.target.closest('.modal-nav-btn');
  if (!btn) return;
  document.querySelectorAll('.modal-nav-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  activePrefsSection = btn.dataset.section;
  const [prefs, dicts] = await Promise.all([
    window.electronAPI.getPreferences(),
    window.electronAPI.listDictionaries(),
  ]);
  currentPrefs = prefs;
  renderPrefsSection(activePrefsSection, prefs, dicts);
});

async function openPreferences() {
  const [prefs, dicts] = await Promise.all([
    window.electronAPI.getPreferences(),
    window.electronAPI.listDictionaries(),
  ]);
  currentPrefs = prefs;
  // Restore active nav button
  document.querySelectorAll('.modal-nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.section === activePrefsSection);
  });
  renderPrefsSection(activePrefsSection, prefs, dicts);
  prefsOverlay.style.display = 'flex';
}

function renderPrefsSection(section, prefs, dicts) {
  switch (section) {
    case 'dictionaries': prefsBody.innerHTML = renderPrefsDicts(dicts);      break;
    case 'wikipedia':    prefsBody.innerHTML = renderPrefsWiki(prefs);        break;
    case 'theme':        prefsBody.innerHTML = renderPrefsTheme(prefs);       break;
    case 'session':      prefsBody.innerHTML = renderPrefsSession(dicts);     break;
  }
  attachPrefsHandlers(section, dicts);
}

// ── Dictionaries section ──
function renderPrefsDicts(dicts) {
  const items = dicts.length === 0
    ? `<p class="prefs-empty">No dictionaries loaded yet.</p>`
    : dicts.map((d, i) => `
      <div class="prefs-dict-item" data-path="${escHtml(d.path)}">
        <span class="prefs-dict-name" title="${escHtml(d.path)}">${escHtml(d.name)}</span>
        <label class="toggle" title="Enable/disable">
          <input type="checkbox" ${d.enabled ? 'checked' : ''} data-action="toggle" data-path="${escHtml(d.path)}">
          <span class="toggle-slider"></span>
        </label>
        <div class="prefs-dict-actions">
          <button class="prefs-icon-btn" data-action="up"   data-path="${escHtml(d.path)}" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
          <button class="prefs-icon-btn" data-action="down" data-path="${escHtml(d.path)}" ${i === dicts.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
          <button class="prefs-icon-btn danger" data-action="remove" data-path="${escHtml(d.path)}" title="Remove">🗑</button>
        </div>
      </div>`).join('');

  return `
    <p class="prefs-section-title">Loaded Dictionaries</p>
    <div class="prefs-dict-list">${items}</div>
    <button class="btn btn-primary" id="prefs-add-dict">+ Add Dictionary</button>`;
}

// ── Wikipedia section ──
function renderPrefsWiki(prefs) {
  const on = prefs.wikipediaEnabled;
  return `
    <p class="prefs-section-title">Wikipedia</p>
    <div class="prefs-field">
      <label class="toggle">
        <input type="checkbox" id="wiki-enabled" ${on ? 'checked' : ''}>
        <span class="toggle-slider"></span>
      </label>
      <label for="wiki-enabled">Enable Wikipedia lookup</label>
    </div>
    <div class="prefs-radio-group prefs-indent" id="wiki-mode-group" style="${on ? '' : 'opacity:0.4;pointer-events:none'}">
      <label>
        <input type="radio" name="wiki-mode" value="fallback" ${prefs.wikipediaAsFallback ? 'checked' : ''}>
        Use as fallback only (when no dictionary result)
      </label>
      <label>
        <input type="radio" name="wiki-mode" value="always" ${!prefs.wikipediaAsFallback ? 'checked' : ''}>
        Always show alongside dictionary results
      </label>
    </div>`;
}

// ── Theme section ──
function renderPrefsTheme(prefs) {
  const t = prefs.theme || 'system';
  return `
    <p class="prefs-section-title">Color Theme</p>
    <div class="prefs-radio-group">
      <label><input type="radio" name="theme" value="system" ${t === 'system' ? 'checked' : ''}> Follow system preference</label>
      <label><input type="radio" name="theme" value="light"  ${t === 'light'  ? 'checked' : ''}> Light</label>
      <label><input type="radio" name="theme" value="dark"   ${t === 'dark'   ? 'checked' : ''}> Dark</label>
    </div>`;
}

// ── Session section ──
function renderPrefsSession(dicts) {
  return `
    <p class="prefs-section-title">Session</p>
    <div class="prefs-stat"><strong>${dicts.length}</strong> dictionar${dicts.length === 1 ? 'y' : 'ies'} loaded</div>
    <div class="prefs-stat"><strong>${lookupCache.size}</strong> word${lookupCache.size === 1 ? '' : 's'} cached this session</div>
    <button class="btn" id="prefs-clear-cache" style="margin-top:8px">Clear cache</button>`;
}

// ── Attach event handlers for each section ──
function attachPrefsHandlers(section, dicts) {
  if (section === 'dictionaries') {
    document.getElementById('prefs-add-dict')?.addEventListener('click', async () => {
      const paths = await window.electronAPI.openMDX();
      if (!paths) return;
      await window.electronAPI.loadDictionaries(paths);
      lookupCache.clear();
      const [newPrefs, newDicts] = await Promise.all([
        window.electronAPI.getPreferences(), window.electronAPI.listDictionaries(),
      ]);
      currentPrefs = newPrefs;
      renderPrefsSection('dictionaries', newPrefs, newDicts);
      await refreshDictBadges();
    });

    // Toggle via checkbox
    document.querySelector('.prefs-dict-list')?.addEventListener('change', async e => {
      if (e.target.dataset.action === 'toggle') {
        await window.electronAPI.toggleDictionary(e.target.dataset.path);
        lookupCache.clear();
        await refreshDictBadges();
      }
    });

    // Up / Down / Remove via buttons
    document.querySelector('.prefs-dict-list')?.addEventListener('click', async e => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.tagName !== 'BUTTON') return;
      const { action, path } = btn.dataset;

      if (action === 'remove') {
        await window.electronAPI.removeDictionary(path);
        lookupCache.clear();
      } else if (action === 'up' || action === 'down') {
        const order = dicts.map(d => d.path);
        const idx   = order.indexOf(path);
        if (action === 'up'   && idx > 0)                { [order[idx-1], order[idx]] = [order[idx], order[idx-1]]; }
        if (action === 'down' && idx < order.length - 1) { [order[idx], order[idx+1]] = [order[idx+1], order[idx]]; }
        await window.electronAPI.reorderDictionaries(order);
        lookupCache.clear();
      }

      const [newPrefs, newDicts] = await Promise.all([
        window.electronAPI.getPreferences(), window.electronAPI.listDictionaries(),
      ]);
      currentPrefs = newPrefs;
      renderPrefsSection('dictionaries', newPrefs, newDicts);
      await refreshDictBadges();
    });
  }

  if (section === 'wikipedia') {
    document.getElementById('wiki-enabled')?.addEventListener('change', async e => {
      await window.electronAPI.savePreferences({ wikipediaEnabled: e.target.checked });
      currentPrefs = await window.electronAPI.getPreferences();
      const dicts2 = await window.electronAPI.listDictionaries();
      renderPrefsSection('wikipedia', currentPrefs, dicts2);
      await refreshDictBadges();
    });
    document.querySelectorAll('[name="wiki-mode"]').forEach(radio => {
      radio.addEventListener('change', async e => {
        await window.electronAPI.savePreferences({ wikipediaAsFallback: e.target.value === 'fallback' });
        currentPrefs = await window.electronAPI.getPreferences();
      });
    });
  }

  if (section === 'theme') {
    document.querySelectorAll('[name="theme"]').forEach(radio => {
      radio.addEventListener('change', async e => {
        const theme = e.target.value;
        await window.electronAPI.savePreferences({ theme });
        currentPrefs = await window.electronAPI.getPreferences();
        applyTheme(theme);
      });
    });
  }

  if (section === 'session') {
    document.getElementById('prefs-clear-cache')?.addEventListener('click', async () => {
      lookupCache.clear();
      const dicts2 = await window.electronAPI.listDictionaries();
      renderPrefsSection('session', currentPrefs, dicts2);
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function extractCleanWord(selection) {
  let raw = selection.toString();
  if (!raw || !raw.trim()) return null;
  let word = raw.trim().split(/\s+/)[0];
  word = word.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, '');
  word = word.replace(/^-+|-+$/g, '');
  if (!word || word.length < 2) return null;
  return word.toLowerCase();
}

function base64ToUint8Array(b64) {
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sanitizeHTML(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?>/gi, '')
    .replace(/<object[\s\S]*?>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\son\w+='[^']*'/gi, '');
}
