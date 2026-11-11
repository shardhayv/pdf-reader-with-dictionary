'use strict';
/**
 * Per-book JSON glossaries, end to end: loading through the real dialog
 * path, looking up through the real candidate ladder, rendering in the
 * popup, and being sanitized exactly like a downloaded dictionary.
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchGloss, waitForDocument, fixture } = require('./helpers');

const GLOSSARY = {
  format: 'gloss-glossary',
  version: 1,
  name: 'देवनागरी परीक्षण — glossary',
  scope: 'global',
  entries: [
    {
      word: 'काठमाडौँ',
      aliases: ['काठमाडौं'],
      definition: '<b>Kathmandu</b> — the capital of Nepal.',
      example: 'काठमाडौँ नेपालको राजधानी हो ।',
      page: 1,
      count: 3,
    },
    { word: 'संयुक्ताक्षर', definition: 'A conjunct consonant.' },
    { word: 'Serendipity', definition: 'Fortunate discovery by accident.' },
    { word: 'unfinished', definition: '' },
    {
      word: 'hostile',
      definition: '<img src=x onerror=alert(1)><a href="javascript:alert(1)">click</a> safe',
    },
  ],
};

function forBook(fileName, extra = {}) {
  return {
    ...GLOSSARY,
    ...extra,
    scope: 'book',
    source: { file: fixture(fileName) },
  };
}

function writeGlossary(value = GLOSSARY) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-glossary-'));
  const file = path.join(dir, 'book.glossary.json');
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

/** Add a file through the same dialog path the user would use. */
async function addDictionary(app, page, file) {
  await app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
  }, file);
  return page.evaluate(() => window.gloss.addDictionaries());
}

test('a glossary loads, answers lookups, and renders in the popup', async () => {
  const { app, page } = await launchGloss({ open: 'devanagari.pdf' });
  try {
    await waitForDocument(page);

    const loaded = await addDictionary(app, page, writeGlossary(forBook('devanagari.pdf', {
      language: 'ne',
    })));
    expect(loaded[0].success).toBe(true);
    expect(loaded[0].kind).toBe('glossary');
    // The display name comes from the file's own "name" field.
    expect(loaded[0].name).toBe('देवनागरी परीक्षण — glossary');

    const listed = await page.evaluate(() => window.gloss.listDictionaries());
    expect(listed).toHaveLength(1);
    expect(listed[0].kind).toBe('glossary');
    expect(listed[0].scope).toBe('book');
    expect(listed[0].applicable).toBe(true);

    // Lookups arrive as the candidate ladder builds them.
    const cases = {
      exact: ['काठमाडौँ'],
      alias: ['काठमाडौं'],
      trimmed: ['काठमाडौँ।', 'काठमाडौँ'],
      conjunct: ['संयुक्ताक्षर'],
      properCase: ['Serendipity', 'serendipity'],
    };
    for (const [label, candidates] of Object.entries(cases)) {
      const hits = await page.evaluate(c => window.gloss.lookupDictionaries(c), candidates);
      expect(hits.length, `${label} should hit`).toBeGreaterThan(0);
      expect(hits[0].dictKind).toBe('glossary');
    }

    // An alias reports the headword, not the alias that matched.
    const viaAlias = await page.evaluate(() => window.gloss.lookupDictionaries(['काठमाडौं']));
    expect(viaAlias[0].keyText).toBe('काठमाडौँ');

    // A draft entry with no definition yet is ignored rather than shown blank.
    expect(await page.evaluate(() => window.gloss.lookupDictionaries(['unfinished'])))
      .toEqual([]);

    // Selecting the word in the document shows the entry and its example.
    const target = await page.evaluate(() => {
      const span = [...document.querySelectorAll('.pdf-text-layer span')]
        .find(s => s.textContent.includes('काठमाडौँ'));
      const r = span.getBoundingClientRect();
      return { x: r.x + 14, y: r.y + r.height / 2 };
    });
    await page.mouse.dblclick(target.x, target.y);
    await expect(page.locator('#popup')).toBeVisible();
    await expect.poll(async () => page.textContent('#popup-word'), { timeout: 10_000 })
      .toBe('काठमाडौँ');
    await expect(page.locator('.popup-definition')).toContainText('Kathmandu');
    await expect(page.locator('.popup-example')).toContainText('नेपालको');
    await expect(page.locator('.popup-entry-meta')).toContainText('first seen');
  } finally {
    await app.close();
  }
});

test('glossary content is sanitized exactly like any other dictionary', async () => {
  const { app, page } = await launchGloss();
  try {
    await addDictionary(app, page, writeGlossary());

    const result = await page.evaluate(async () => {
      const { sanitizeDefinition } = await import('./js/popup.js');
      const [hit] = await window.gloss.lookupDictionaries(['hostile']);
      const host = document.createElement('div');
      host.innerHTML = sanitizeDefinition(hit.definition);
      return {
        raw: hit.definition,
        images: host.querySelectorAll('img').length,
        liveHrefs: host.querySelectorAll('[href]').length,
        handlers: [...host.querySelectorAll('*')]
          .some(el => [...el.attributes].some(a => /^on/i.test(a.name))),
        text: host.textContent.trim(),
      };
    });

    // Stored verbatim — the glossary backend must not pretend to sanitize.
    expect(result.raw).toContain('onerror');
    // Neutralized on the way to the DOM.
    expect(result.images).toBe(0);
    expect(result.liveHrefs).toBe(0);
    expect(result.handlers).toBe(false);
    expect(result.text).toContain('safe');
  } finally {
    await app.close();
  }
});

test('MDX priority controls apply to glossaries too', async () => {
  const { app, page } = await launchGloss();
  try {
    const a = writeGlossary({ name: 'First', entries: [{ word: 'water', definition: 'from first' }] });
    const b = writeGlossary({ name: 'Second', entries: [{ word: 'water', definition: 'from second' }] });
    await addDictionary(app, page, a);
    await addDictionary(app, page, b);

    const order = () => page.evaluate(async () =>
      (await window.gloss.lookupDictionaries(['water'])).map(r => r.dictName));
    expect(await order()).toEqual(['First', 'Second']);

    const paths = (await page.evaluate(() => window.gloss.listDictionaries())).map(d => d.path);
    await page.evaluate(p => window.gloss.reorderDictionaries(p), [paths[1], paths[0]]);
    expect(await order()).toEqual(['Second', 'First']);

    await page.evaluate(p => window.gloss.toggleDictionary(p), paths[1]);
    expect(await order()).toEqual(['First']);
  } finally {
    await app.close();
  }
});

test('book-scoped glossaries switch automatically with the open PDF', async () => {
  const { app, page } = await launchGloss({ open: 'devanagari.pdf' });
  try {
    await waitForDocument(page);
    const devanagari = writeGlossary(forBook('devanagari.pdf', {
      name: 'Devanagari book',
      entries: [{ word: 'contextual', definition: 'meaning for the Devanagari book' }],
    }));
    const latin = writeGlossary(forBook('latin.pdf', {
      name: 'Latin book',
      entries: [{ word: 'contextual', definition: 'meaning for the Latin book' }],
    }));
    await addDictionary(app, page, devanagari);
    await addDictionary(app, page, latin);

    const active = async () => page.evaluate(async () => ({
      hits: (await window.gloss.lookupDictionaries(['contextual'])).map(hit => hit.definition),
      sources: (await window.gloss.listDictionaries()).map(item => ({ name: item.name, applicable: item.applicable })),
    }));
    expect(await active()).toEqual({
      hits: ['meaning for the Devanagari book'],
      sources: [
        { name: 'Devanagari book', applicable: true },
        { name: 'Latin book', applicable: false },
      ],
    });

    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, fixture('latin.pdf'));
    await page.click('#btn-open');
    await waitForDocument(page);
    expect(await active()).toEqual({
      hits: ['meaning for the Latin book'],
      sources: [
        { name: 'Devanagari book', applicable: false },
        { name: 'Latin book', applicable: true },
      ],
    });

    // Only the source for the current book appears in the reading toolbar;
    // other books stay loaded silently for automatic switching later.
    await page.click('#btn-sources');
    await expect(page.locator('#sources-menu')).toBeVisible();
    await expect(page.locator('#sources-menu [data-source-path]')).toHaveCount(1);
    await expect(page.locator('#sources-menu')).toContainText('This book');
    await expect(page.locator('#sources-menu')).toContainText('Latin book');
    await expect(page.locator('#sources-menu')).not.toContainText('Devanagari book');
  } finally {
    await app.close();
  }
});

test('reloading an edited glossary keeps the old copy on error and adopts a fixed copy', async () => {
  const file = writeGlossary({
    ...GLOSSARY,
    name: 'Editable glossary',
    entries: [{ word: 'liminal', definition: 'old working definition' }],
  });
  const { app, page } = await launchGloss();
  try {
    await addDictionary(app, page, file);
    const definition = () => page.evaluate(async () =>
      (await window.gloss.lookupDictionaries(['liminal']))[0]?.definition || '');
    expect(await definition()).toBe('old working definition');

    await page.click('#btn-prefs');
    await expect(page.locator('.dict-row')).toHaveCount(1);
    fs.writeFileSync(file, '{ broken JSON');
    await page.click('[data-act="reload"]');
    await expect(page.locator('#prefs-body .prefs-error')).toContainText('previous working copy is still active');
    expect(await definition()).toBe('old working definition');

    fs.writeFileSync(file, JSON.stringify({
      ...GLOSSARY,
      name: 'Editable glossary',
      entries: [{ word: 'liminal', definition: 'new AI-assisted definition' }],
    }));
    await page.click('[data-act="reload"]');
    await expect(page.locator('#prefs-body .prefs-error')).toHaveCount(0);
    expect(await definition()).toBe('new AI-assisted definition');
  } finally {
    await app.close();
  }
});

test('a malformed glossary is reported and does not load', async () => {
  const { app, page } = await launchGloss();
  try {
    const results = await addDictionary(app, page, writeGlossary('{ not json at all'));
    expect(results[0].success).toBe(false);
    expect(results[0].error).toMatch(/json/i);
    expect(await page.evaluate(() => window.gloss.listDictionaries())).toEqual([]);
  } finally {
    await app.close();
  }
});
