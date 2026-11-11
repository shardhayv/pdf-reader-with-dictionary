/**
 * Dictionary lookup ordering.
 *
 * main/dicts.js consumes the candidate ladder built by renderer/js/text.js.
 * These tests pin the consumption rules that make proper-case and exact
 * entries discoverable: candidates are tried in order, the first hit per
 * dictionary wins, and dictionaries are consulted in priority order.
 *
 * electron and js-mdict are stubbed through the require cache so the module
 * can run outside an Electron process.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.GLOSS_SYNC_MDX = '1';

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-dicts-'));
require.cache[require.resolve('electron')] = {
  id: 'electron', filename: 'electron', loaded: true,
  exports: { app: { getPath: () => userDataDir } },
};

/** Dictionary contents keyed by headword, per fake file. */
const CONTENTS = new Map();

class FakeMDX {
  constructor(file) {
    this.file = file;
    this.queries = [];
  }
  lookup(word) {
    this.queries.push(word);
    const entries = CONTENTS.get(this.file) || {};
    if (entries[word] instanceof Error) throw entries[word];
    return Object.prototype.hasOwnProperty.call(entries, word)
      ? { keyText: word, definition: entries[word] }
      : { keyText: word, definition: null };
  }
  close() {}
}
require.cache[require.resolve('js-mdict')] = {
  id: 'js-mdict', filename: 'js-mdict', loaded: true,
  exports: { MDX: FakeMDX },
};

const store = require('../../main/store.js');
const dicts = require('../../main/dicts.js');
store.load();

/** Create a real file (dicts.js realpaths it) and register its contents. */
function makeDictionary(name, entries) {
  const file = path.join(userDataDir, `${name}.mdx`);
  fs.writeFileSync(file, 'stub');
  const real = fs.realpathSync(file);
  CONTENTS.set(real, entries);
  return real;
}

function resetDictionaries() {
  for (const d of dicts.list()) dicts.remove(d.path);
}

test('the first matching candidate wins, so exact case is preferred', async () => {
  resetDictionaries();
  // A dictionary holding both a proper-case and a lowercase headword.
  const file = makeDictionary('proper', {
    Paris: 'the capital of France',
    paris: 'plaster of paris',
    NASA: 'space agency',
  });
  await dicts.loadMany([file]);

  // The ladder for "Paris" is [Paris, paris, PARIS].
  const [hit] = await dicts.lookup(['Paris', 'paris', 'PARIS']);
  assert.equal(hit.matchedCandidate, 'Paris');
  assert.equal(hit.definition, 'the capital of France');

  // Lowercase selection still reaches the lowercase entry.
  const [lower] = await dicts.lookup(['paris', 'Paris', 'PARIS']);
  assert.equal(lower.matchedCandidate, 'paris');
  assert.equal(lower.definition, 'plaster of paris');

  // An acronym keyed only in upper case is found from its exact form.
  const [acronym] = await dicts.lookup(['NASA', 'nasa', 'Nasa']);
  assert.equal(acronym.matchedCandidate, 'NASA');
});

test('a later candidate is used when the exact form misses', async () => {
  resetDictionaries();
  const file = makeDictionary('folded', { café: 'a coffee house' });
  await dicts.loadMany([file]);

  // Selection included punctuation; the trimmed rung matches.
  const [hit] = await dicts.lookup(['«café»,', 'café']);
  assert.equal(hit.matchedCandidate, 'café');
  assert.equal(hit.definition, 'a coffee house');
});

test('Devanagari candidates are tried verbatim, in order', async () => {
  resetDictionaries();
  const file = makeDictionary('nepali', { 'काठमाडौँ': 'the capital of Nepal' });
  await dicts.loadMany([file]);

  const [hit] = await dicts.lookup(['काठमाडौँ।', 'काठमाडौँ']);
  assert.equal(hit.matchedCandidate, 'काठमाडौँ');
  assert.equal(hit.definition, 'the capital of Nepal');
});

test('every enabled dictionary contributes at most one result, in priority order', async () => {
  resetDictionaries();
  const first = makeDictionary('first', { water: 'H2O, from dictionary one' });
  const second = makeDictionary('second', { water: 'from dictionary two', Water: 'capitalised' });
  await dicts.loadMany([first, second]);

  const results = await dicts.lookup(['water', 'Water', 'WATER']);
  assert.equal(results.length, 2);
  assert.equal(results[0].dictName, 'first');
  assert.equal(results[1].dictName, 'second');
  // One hit per dictionary, even though "second" also has a capitalised key.
  assert.equal(results[1].matchedCandidate, 'water');

  // Reordering changes which dictionary answers first.
  dicts.reorder([second, first]);
  const reordered = await dicts.lookup(['water']);
  assert.equal(reordered[0].dictName, 'second');
});

test('disabled dictionaries are skipped entirely', async () => {
  resetDictionaries();
  const file = makeDictionary('toggleable', { tree: 'a plant' });
  await dicts.loadMany([file]);
  assert.equal((await dicts.lookup(['tree'])).length, 1);

  dicts.toggle(file);
  assert.equal((await dicts.lookup(['tree'])).length, 0);

  dicts.toggle(file);
  assert.equal((await dicts.lookup(['tree'])).length, 1);
});

test('lookup rejects malformed candidate lists without throwing', async () => {
  resetDictionaries();
  const file = makeDictionary('safe', { ok: 'fine' });
  await dicts.loadMany([file]);

  assert.deepEqual(await dicts.lookup('not an array'), []);
  assert.deepEqual(await dicts.lookup(null), []);
  assert.deepEqual(await dicts.lookup([]), []);
  assert.deepEqual(await dicts.lookup(['', null, 42, {}]), []);
  // Oversized candidates are dropped rather than passed to the parser.
  assert.deepEqual(await dicts.lookup(['x'.repeat(500)]), []);
});

test('one failed dictionary is reported without hiding healthy results', async () => {
  resetDictionaries();
  const broken = makeDictionary('temporarily-unavailable', {
    water: new Error('simulated parser failure'),
  });
  const healthy = makeDictionary('healthy', { water: 'a clear liquid' });
  await dicts.loadMany([broken, healthy]);

  const results = await dicts.lookup(['water']);
  assert.equal(results.length, 2);
  assert.equal(results[0].dictName, 'temporarily-unavailable');
  assert.match(results[0].error, /parser failure/);
  assert.equal(results[1].definition, 'a clear liquid');
  assert.match(dicts.list()[0].error, /parser failure/);
});

test('MDX dictionaries and JSON glossaries share one priority list', async () => {
  resetDictionaries();
  const mdx = makeDictionary('oxford', { water: 'from the MDX dictionary' });

  const glossaryPath = path.join(userDataDir, 'book.glossary.json');
  fs.writeFileSync(glossaryPath, JSON.stringify({
    name: 'Book glossary',
    entries: [
      { word: 'water', definition: 'from the glossary' },
      { word: 'काठमाडौँ', definition: 'Kathmandu', aliases: ['काठमाडौं'] },
    ],
  }));

  await dicts.loadMany([mdx, glossaryPath]);
  const listed = dicts.list();
  assert.deepEqual(listed.map(d => d.kind), ['mdx', 'glossary']);
  // A glossary takes its display name from the file's own "name" field.
  assert.equal(listed[1].name, 'Book glossary');

  // Both answer, in list order, and each reports which backend it came from.
  const results = await dicts.lookup(['water']);
  assert.deepEqual(results.map(r => r.definition),
    ['from the MDX dictionary', 'from the glossary']);
  assert.deepEqual(results.map(r => r.dictKind), ['mdx', 'glossary']);

  // Reordering and toggling work the same for either backend.
  dicts.reorder([glossaryPath, mdx]);
  assert.equal((await dicts.lookup(['water']))[0].dictKind, 'glossary');
  dicts.toggle(glossaryPath);
  assert.deepEqual((await dicts.lookup(['water'])).map(r => r.dictKind), ['mdx']);
  dicts.toggle(glossaryPath);

  // Glossary aliases resolve through the normal candidate ladder.
  const alias = await dicts.lookup(['काठमाडौं।', 'काठमाडौं']);
  assert.equal(alias[0].definition, 'Kathmandu');
  assert.equal(alias[0].keyText, 'काठमाडौँ');
});

test('a per-book glossary never answers for the wrong PDF', async () => {
  resetDictionaries();
  const mdx = makeDictionary('general', { bank: 'general MDX meaning' });
  const book = path.join(userDataDir, 'finance-book.pdf');
  const other = path.join(userDataDir, 'novel.pdf');
  fs.writeFileSync(book, '%PDF-1.7\n');
  fs.writeFileSync(other, '%PDF-1.7\n');
  const glossaryPath = path.join(userDataDir, 'finance-book.glossary.json');
  fs.writeFileSync(glossaryPath, JSON.stringify({
    scope: 'book',
    source: { file: path.basename(book), fingerprint: 'book-fingerprint' },
    entries: [{ word: 'bank', definition: 'meaning in this particular book', count: 11, page: 4 }],
  }));

  await dicts.loadMany([mdx, glossaryPath]);
  const withoutBook = dicts.list();
  assert.equal(withoutBook[0].applicable, true);
  assert.equal(withoutBook[1].applicable, false);
  assert.deepEqual((await dicts.lookup(['bank'])).map(hit => hit.dictKind), ['mdx']);

  const forBook = { path: book, fingerprint: '' };
  assert.equal(dicts.list(forBook)[1].active, true);
  const hits = await dicts.lookup(['bank'], forBook);
  assert.deepEqual(hits.map(hit => hit.definition), [
    'general MDX meaning', 'meaning in this particular book',
  ]);
  assert.equal(hits[1].page, 4);
  assert.equal(hits[1].count, 11);

  assert.deepEqual((await dicts.lookup(['bank'], { path: other, fingerprint: 'different' }))
    .map(hit => hit.dictKind), ['mdx']);
  // A moved/renamed copy can still match the stable PDF fingerprint.
  assert.equal((await dicts.lookup(['bank'], { path: other, fingerprint: 'BOOK-FINGERPRINT' })).length, 2);
});

test('reload is transactional: a broken edit keeps the previous glossary active', async () => {
  resetDictionaries();
  const glossaryPath = path.join(userDataDir, 'editable.glossary.json');
  fs.writeFileSync(glossaryPath, JSON.stringify({
    entries: [{ word: 'liminal', definition: 'old working definition' }],
  }));
  const realPath = fs.realpathSync(glossaryPath);
  await dicts.loadMany([realPath]);
  assert.equal((await dicts.lookup(['liminal']))[0].definition, 'old working definition');

  fs.writeFileSync(glossaryPath, '{ broken JSON');
  const failed = await dicts.reload(realPath);
  assert.equal(failed.success, false);
  assert.match(failed.error, /json/i);
  assert.equal((await dicts.lookup(['liminal']))[0].definition, 'old working definition');

  fs.writeFileSync(glossaryPath, JSON.stringify({
    entries: [
      { word: 'liminal', definition: 'new AI-assisted definition' },
      { word: 'प्रज्ञा', definition: 'wisdom' },
    ],
  }));
  const reloaded = await dicts.reload(realPath);
  assert.equal(reloaded.success, true);
  assert.equal((await dicts.lookup(['liminal']))[0].definition, 'new AI-assisted definition');
  assert.equal((await dicts.lookup(['प्रज्ञा']))[0].definition, 'wisdom');
});

test('a broken glossary is reported like any other unreadable dictionary', async () => {
  resetDictionaries();
  const broken = path.join(userDataDir, 'broken.glossary.json');
  fs.writeFileSync(broken, '{ this is not json');
  const [result] = await dicts.loadMany([broken]);
  assert.equal(result.success, false);
  assert.match(result.error, /json/i);
  assert.equal(dicts.list().length, 0);
});

test('a dictionary that fails to load is reported, not thrown', async () => {
  resetDictionaries();
  const results = await dicts.loadMany([path.join(userDataDir, 'does-not-exist.mdx')]);
  assert.equal(results.length, 1);
  assert.equal(results[0].success, false);
  assert.match(results[0].error, /not found/i);
});

// ── Packaged dictionaries ─────────────────────────────────────────────────────

function makePackage(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-package-'));
  for (const name of names) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify({
      format: 'gloss-glossary', version: 1, scope: 'global', name: `Packaged ${name}`,
      entries: [{ word: 'shelf', definition: `from ${name}` }],
    }));
  }
  return fs.realpathSync(dir);
}

function clearShelf() {
  resetDictionaries();
  store.setPrefsInternal(prefs => { prefs.dictionaries = { order: [], enabled: {}, bundledSeen: [] }; });
}

test('packaged dictionaries are offered once, and a removed one stays removed', async () => {
  clearShelf();
  const pkg = makePackage(['01-alpha.json', '02-beta.json']);

  // First launch: both arrive, enabled, in file order.
  await dicts.restoreFromPrefs({ bundledDirs: [pkg] });
  assert.deepEqual(dicts.list().map(d => d.name), ['Packaged 01-alpha.json', 'Packaged 02-beta.json']);
  assert.deepEqual(store.getPrefs().dictionaries.bundledSeen, ['01-alpha.json', '02-beta.json']);

  // The reader removes every one of them. The next launch must not undo that.
  resetDictionaries();
  assert.deepEqual(store.getPrefs().dictionaries.order, []);
  await dicts.restoreFromPrefs({ bundledDirs: [pkg] });
  assert.deepEqual(dicts.list(), []);

  // A later release ships one more: only the new one is added.
  fs.writeFileSync(path.join(pkg, '03-gamma.json'), JSON.stringify({
    format: 'gloss-glossary', version: 1, scope: 'global', name: 'Packaged 03-gamma.json',
    entries: [{ word: 'shelf', definition: 'new' }],
  }));
  await dicts.restoreFromPrefs({ bundledDirs: [pkg] });
  assert.deepEqual(dicts.list().map(d => d.name), ['Packaged 03-gamma.json']);
});

test('a packaged dictionary is followed when its folder moves, keeping its on/off choice', async () => {
  clearShelf();
  const oldPkg = makePackage(['01-alpha.json', '02-beta.json']);
  await dicts.restoreFromPrefs({ bundledDirs: [oldPkg] });
  dicts.toggle(path.join(oldPkg, '02-beta.json'));            // reader switches one off
  assert.deepEqual(dicts.list().map(d => d.enabled), [true, false]);

  // A portable build unpacks somewhere new on every launch.
  const newPkg = makePackage(['01-alpha.json', '02-beta.json']);
  fs.rmSync(oldPkg, { recursive: true, force: true });
  for (const d of dicts.list()) dicts.remove(d.path);
  store.setPrefsInternal(prefs => {
    prefs.dictionaries.order = [path.join(oldPkg, '01-alpha.json'), path.join(oldPkg, '02-beta.json')];
    prefs.dictionaries.enabled = {
      [path.join(oldPkg, '01-alpha.json')]: true, [path.join(oldPkg, '02-beta.json')]: false,
    };
  });

  const results = await dicts.restoreFromPrefs({ bundledDirs: [newPkg] });
  assert.ok(results.every(r => r.success));
  assert.deepEqual(dicts.list().map(d => [path.dirname(d.path), d.enabled]),
    [[newPkg, true], [newPkg, false]]);
});

test('a copy the reader already has wins over the packaged file of the same name', async () => {
  clearShelf();
  const own = makePackage(['01-alpha.json']);     // e.g. built by `npm run dictionaries`
  const pkg = makePackage(['01-alpha.json', '02-beta.json']);
  store.setPrefsInternal(prefs => {
    prefs.dictionaries.order = [path.join(own, '01-alpha.json')];
    prefs.dictionaries.enabled = { [path.join(own, '01-alpha.json')]: true };
  });
  await dicts.restoreFromPrefs({ bundledDirs: [pkg] });
  assert.deepEqual(dicts.list().map(d => d.path),
    [path.join(own, '01-alpha.json'), path.join(pkg, '02-beta.json')]);
});

test('a saved dictionary that has vanished is reported instead of silently dropped', async () => {
  clearShelf();
  const gone = path.join(userDataDir, 'gone.glossary.json');
  store.setPrefsInternal(prefs => {
    prefs.dictionaries.order = [gone];
    prefs.dictionaries.enabled = { [gone]: true };
  });
  const results = await dicts.restoreFromPrefs({ bundledDirs: [] });
  assert.equal(results.length, 1);
  assert.equal(results[0].success, false);
  assert.match(results[0].error, /not found/i);
});

test('GLOSS_NO_BUNDLED_DICTIONARIES turns the packaged shelf off', () => {
  const before = process.env.GLOSS_NO_BUNDLED_DICTIONARIES;
  process.env.GLOSS_NO_BUNDLED_DICTIONARIES = '1';
  try {
    assert.deepEqual(dicts.getBundledDictionaryPaths(), []);
  } finally {
    if (before === undefined) delete process.env.GLOSS_NO_BUNDLED_DICTIONARIES;
    else process.env.GLOSS_NO_BUNDLED_DICTIONARIES = before;
  }
});

test('general English is seeded ahead of the other packaged dictionaries', async () => {
  clearShelf();
  const pkg = makePackage(['01-subject.json', '10-general-english-wordnet.json', '11-devanagari.json']);
  assert.deepEqual(dicts.getBundledDictionaryPaths([pkg]).map(p => path.basename(p)),
    ['10-general-english-wordnet.json', '01-subject.json', '11-devanagari.json']);
  await dicts.restoreFromPrefs({ bundledDirs: [pkg] });
  assert.equal(dicts.list()[0].name, 'Packaged 10-general-english-wordnet.json');
});

test('a dictionary an older build shipped and this one does not is dropped quietly', async () => {
  clearShelf();
  // Simulate an upgrade: the old package had 01 and 10, the new one only 10.
  const oldPkg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-old-')), 'dictionaries');
  const newPkg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-new-')), 'dictionaries');
  fs.mkdirSync(newPkg);
  fs.writeFileSync(path.join(newPkg, '10-general.json'), JSON.stringify({
    format: 'gloss-glossary', version: 1, scope: 'global', name: 'General',
    entries: [{ word: 'shelf', definition: 'a flat surface' }],
  }));
  store.setPrefsInternal(prefs => {
    prefs.dictionaries.order = [path.join(oldPkg, '01-subject.json'), path.join(oldPkg, '10-general.json')];
    prefs.dictionaries.enabled = {};
    prefs.dictionaries.bundledSeen = ['01-subject.json', '10-general.json'];
  });
  const results = await dicts.restoreFromPrefs({ bundledDirs: [fs.realpathSync(newPkg)] });
  // No "could not restore" failure for the retired file; the kept one follows.
  assert.deepEqual(results.map(r => r.success), [true]);
  assert.deepEqual(dicts.list().map(d => d.name), ['General']);
});

test('the candidate ladder may be long, but is still capped', async () => {
  resetDictionaries();
  const file = makeDictionary('long', { base: 'found at the end of a long ladder' });
  await dicts.loadMany([file]);
  const ladder = Array.from({ length: 31 }, (_, i) => `miss${i}`).concat('base');
  const [hit] = await dicts.lookup(ladder);
  assert.equal(hit.matchedCandidate, 'base');
  // Beyond the cap nothing is consulted.
  assert.deepEqual(await dicts.lookup(Array.from({ length: 32 }, (_, i) => `miss${i}`).concat('base')), []);
});
