'use strict';
/**
 * Security regressions. Dictionary content is untrusted input: these specs
 * assert that hostile HTML cannot execute code, navigate the window, open
 * windows, reach the network, or expose Electron APIs.
 */

const { test, expect } = require('@playwright/test');
const { launchGloss, collectErrors } = require('./helpers');

let app, page;

test.beforeAll(async () => {
  ({ app, page } = await launchGloss());
});

test.afterAll(async () => {
  await app?.close();
});

/**
 * Each payload is sanitized through the real popup pipeline, inserted into
 * a live DOM node, and inspected. `expect` describes the intended outcome.
 */
const PAYLOADS = [
  { name: 'unquoted event handler', html: '<img src=x onerror=alert(1)>' },
  { name: 'quoted event handler', html: '<img src="x" onerror="alert(1)">' },
  { name: 'javascript: href', html: '<a href="javascript:alert(1)">x</a>' },
  { name: 'JaVaScRiPt: href', html: '<a href="JaVaScRiPt:alert(1)">x</a>' },
  { name: 'data: html href', html: '<a href="data:text/html,<script>alert(1)</script>">x</a>' },
  { name: 'file: href', html: '<a href="file:///etc/passwd">x</a>' },
  { name: 'vbscript: href', html: '<a href="vbscript:msgbox(1)">x</a>' },
  { name: 'target=_blank', html: '<a target="_blank" href="https://example.com/">x</a>' },
  { name: 'svg script', html: '<svg><script>alert(1)</script></svg>' },
  { name: 'svg onload', html: '<svg onload=alert(1)></svg>' },
  { name: 'iframe', html: '<iframe src="https://example.com"></iframe>' },
  { name: 'object', html: '<object data="x"></object>' },
  { name: 'embed', html: '<embed src="x">' },
  { name: 'form action', html: '<form action="https://example.com"><input name=a></form>' },
  { name: 'meta refresh', html: '<meta http-equiv="refresh" content="0;url=https://example.com">' },
  { name: 'style import', html: '<style>@import url("https://example.com/t.css")</style>' },
  { name: 'style expression attr', html: '<div style="width:expression(alert(1))">x</div>' },
  { name: 'remote tracking image', html: '<img src="https://example.com/pixel.gif">' },
  { name: 'base href', html: '<base href="https://example.com/">' },
  { name: 'noscript mXSS', html: '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>' },
  { name: 'math/mglyph mXSS', html: '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>' },
  { name: 'template', html: '<template><img src=x onerror=alert(1)></template>' },
  { name: 'malformed nesting', html: '<b>ok<i>nest</b>ed</i>' },
  { name: 'onclick on allowed link', html: '<a href="https://example.com/" onclick="alert(1)">x</a>' },
  { name: 'xlink href', html: '<a xlink:href="javascript:alert(1)">x</a>' },
];

test('hostile dictionary HTML is neutralized', async () => {
  const results = await page.evaluate(async (payloads) => {
    const { sanitizeDefinition } = await import('./js/popup.js');
    const host = document.createElement('div');
    host.style.display = 'none';
    document.body.appendChild(host);

    return payloads.map(({ name, html }) => {
      const clean = sanitizeDefinition(html);
      host.innerHTML = clean;
      const out = {
        name,
        clean,
        // Anything that could execute, navigate, or fetch:
        hasScript: !!host.querySelector('script, iframe, object, embed, svg, math, template, form, meta, base, style, link'),
        hasMedia: !!host.querySelector('img, audio, video, source, track'),
        liveHrefs: [...host.querySelectorAll('[href]')].map(a => a.getAttribute('href')),
        srcs: [...host.querySelectorAll('[src]')].map(a => a.getAttribute('src')),
        inlineHandlers: [...host.querySelectorAll('*')].flatMap(el =>
          [...el.attributes].filter(a => /^on/i.test(a.name)).map(a => a.name)),
        styleAttrs: [...host.querySelectorAll('[style]')].length,
        targets: [...host.querySelectorAll('[target]')].length,
        text: host.textContent,
      };
      host.innerHTML = '';
      return out;
    });
  }, PAYLOADS);

  const problems = [];
  for (const r of results) {
    if (r.hasScript) problems.push(`${r.name}: executable/foreign element survived -> ${r.clean}`);
    if (r.hasMedia) problems.push(`${r.name}: media element survived (remote fetch) -> ${r.clean}`);
    if (r.liveHrefs.length) problems.push(`${r.name}: live href survived -> ${r.liveHrefs.join(',')}`);
    if (r.srcs.length) problems.push(`${r.name}: src attribute survived -> ${r.srcs.join(',')}`);
    if (r.inlineHandlers.length) problems.push(`${r.name}: inline handler survived -> ${r.inlineHandlers.join(',')}`);
    if (r.styleAttrs) problems.push(`${r.name}: style attribute survived -> ${r.clean}`);
    if (r.targets) problems.push(`${r.name}: target attribute survived -> ${r.clean}`);
    if (/javascript:|vbscript:|expression\(/i.test(r.clean)) {
      problems.push(`${r.name}: dangerous scheme survived -> ${r.clean}`);
    }
  }
  expect(problems, problems.join('\n')).toEqual([]);

  // Benign markup must still survive, or the sanitizer is useless.
  const benign = results.find(r => r.name === 'malformed nesting');
  expect(benign.text).toContain('nest');
});

test('safe links become inert data attributes, not navigable hrefs', async () => {
  const result = await page.evaluate(async () => {
    const { sanitizeDefinition } = await import('./js/popup.js');
    const host = document.createElement('div');
    host.innerHTML = sanitizeDefinition(
      '<a href="https://en.wikipedia.org/wiki/Gloss">web</a> ' +
      '<a href="entry://काठमाडौँ">cross-reference</a>'
    );
    const [external, entry] = host.querySelectorAll('a');
    return {
      externalHref: external.getAttribute('href'),
      externalData: external.getAttribute('data-external'),
      externalRel: external.getAttribute('rel'),
      entryHref: entry.getAttribute('href'),
      entryData: entry.getAttribute('data-entry'),
      keyboardReachable: entry.getAttribute('tabindex') === '0' && entry.getAttribute('role') === 'link',
    };
  });

  // No live href anywhere: a sanitizer bypass still cannot navigate.
  expect(result.externalHref).toBeNull();
  expect(result.entryHref).toBeNull();
  expect(result.externalData).toBe('https://en.wikipedia.org/wiki/Gloss');
  expect(result.externalRel).toBe('noopener noreferrer');
  expect(result.entryData).toBe('काठमाडौँ');
  expect(result.keyboardReachable).toBe(true);
});

test('renderer has no Node or Electron capabilities', async () => {
  const exposure = await page.evaluate(() => ({
    require: typeof window.require,
    process: typeof window.process,
    module: typeof window.module,
    electron: typeof window.electron,
    ipcRenderer: typeof window.ipcRenderer,
    glossKeys: Object.keys(window.gloss).sort(),
  }));

  expect(exposure.require).toBe('undefined');
  expect(exposure.process).toBe('undefined');
  expect(exposure.module).toBe('undefined');
  expect(exposure.electron).toBe('undefined');
  expect(exposure.ipcRenderer).toBe('undefined');

  // The bridge surface is deliberately small and fully enumerated here so
  // that accidentally widening it fails this test.
  expect(exposure.glossKeys).toEqual([
    'addDictionaries', 'clearRecents', 'confirmOpen', 'getPrefs', 'getRecents',
    'listDictionaries', 'lookupDictionaries', 'lookupWikipedia', 'notifyReady',
    'onCommand', 'onOpenFile', 'openDroppedPdf', 'openExternal', 'openPdfDialog',
    'openRecent', 'removeDictionary', 'reorderDictionaries', 'setPrefs',
    'setReadMode', 'toggleDictionary', 'updateDocState',
  ]);
});

test('window security preferences are hardened', async () => {
  const prefs = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const wp = win.webContents.getLastWebPreferences();
    return {
      contextIsolation: wp.contextIsolation,
      nodeIntegration: wp.nodeIntegration,
      sandbox: wp.sandbox,
      webviewTag: wp.webviewTag,
      url: win.webContents.getURL(),
    };
  });

  expect(prefs.contextIsolation).not.toBe(false);
  expect(prefs.nodeIntegration).toBeFalsy();
  expect(prefs.sandbox).not.toBe(false);
  expect(prefs.webviewTag).toBeFalsy();
  expect(prefs.url.startsWith('file://')).toBe(true);
});

test('navigation and new windows are denied', async () => {
  const errors = collectErrors(page);
  const before = app.windows().length;

  const outcome = await page.evaluate(() => {
    const results = {};
    try {
      results.openReturned = String(window.open('https://example.com', '_blank'));
    } catch (e) { results.openThrew = e.message; }
    try {
      window.location.href = 'https://example.com/';
      results.assignedLocation = true;
    } catch (e) { results.locationThrew = e.message; }
    return results;
  });
  void outcome;

  await page.waitForTimeout(1200);

  // Still our own file:// document, still exactly one window.
  expect(page.url().startsWith('file://')).toBe(true);
  expect(app.windows().length).toBe(before);
  expect(errors.join('\n')).not.toMatch(/Uncaught/);
});

test('openExternal refuses non-http(s) schemes', async () => {
  const results = await page.evaluate(async () => {
    const out = {};
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>alert(1)</script>',
      'gloss-evil://x',
      'ftp://example.com/x',
    ]) {
      try { out[url] = await window.gloss.openExternal(url); }
      catch (e) { out[url] = 'threw: ' + e.message; }
    }
    return out;
  });

  for (const [url, result] of Object.entries(results)) {
    expect(result && result.ok, `${url} should be refused`).toBeFalsy();
  }
});

test('IPC rejects malformed arguments without crashing', async () => {
  const survived = await page.evaluate(async () => {
    const calls = [
      () => window.gloss.openRecent('/etc/passwd'),
      () => window.gloss.openRecent(''),
      () => window.gloss.openDroppedPdf(null),
      () => window.gloss.removeDictionary(''),
      () => window.gloss.toggleDictionary('x'.repeat(9000)),
      () => window.gloss.lookupDictionaries('not-an-array'),
      () => window.gloss.lookupDictionaries(new Array(5000).fill('x')),
      () => window.gloss.reorderDictionaries('nope'),
      () => window.gloss.updateDocState('/etc/passwd', { page: 1 }),
      () => window.gloss.setPrefs({ theme: '../../evil', wikipediaLang: 'zz' }),
      () => window.gloss.lookupWikipedia('zz', 'x'),
    ];
    for (const call of calls) {
      try { await call(); } catch { /* rejection is an acceptable outcome */ }
    }
    return true;
  });
  expect(survived).toBe(true);

  // Preferences must still be valid after the tampering attempts.
  const prefs = await page.evaluate(() => window.gloss.getPrefs());
  expect(['system', 'light', 'dark']).toContain(prefs.theme);
  expect(['en', 'hi', 'ne', 'mai']).toContain(prefs.wikipediaLang);
});

test('renderer cannot read arbitrary files', async () => {
  // No bridge method reads a caller-supplied path. Opening always requires
  // a user action the main process itself observed (dialog, CLI argument,
  // drop resolved in the preload, or an entry already in recents).
  const results = await page.evaluate(async () => ({
    // A path never approved this session is refused even though it exists.
    unapprovedRecent: await window.gloss.openRecent('/etc/passwd'),
    // A fabricated "file" cannot masquerade as a dropped File object.
    fabricatedDrop: await window.gloss.openDroppedPdf({ path: '/etc/passwd', name: 'x.pdf' }),
    stringDrop: await window.gloss.openDroppedPdf('/etc/passwd'),
  }));

  expect(results.unapprovedRecent.ok).toBeFalsy();
  expect(results.fabricatedDrop.ok).toBeFalsy();
  expect(results.stringDrop.ok).toBeFalsy();
});
