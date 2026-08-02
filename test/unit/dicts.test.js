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

test('the first matching candidate wins, so exact case is preferred', () => {
  resetDictionaries();
  // A dictionary holding both a proper-case and a lowercase headword.
  const file = makeDictionary('proper', {
    Paris: 'the capital of France',
    paris: 'plaster of paris',
    NASA: 'space agency',
  });
  dicts.loadMany([file]);

  // The ladder for "Paris" is [Paris, paris, PARIS].
  const [hit] = dicts.lookup(['Paris', 'paris', 'PARIS']);
  assert.equal(hit.matchedCandidate, 'Paris');
  assert.equal(hit.definition, 'the capital of France');

  // Lowercase selection still reaches the lowercase entry.
  const [lower] = dicts.lookup(['paris', 'Paris', 'PARIS']);
  assert.equal(lower.matchedCandidate, 'paris');
  assert.equal(lower.definition, 'plaster of paris');

  // An acronym keyed only in upper case is found from its exact form.
  const [acronym] = dicts.lookup(['NASA', 'nasa', 'Nasa']);
  assert.equal(acronym.matchedCandidate, 'NASA');
});

test('a later candidate is used when the exact form misses', () => {
  resetDictionaries();
  const file = makeDictionary('folded', { café: 'a coffee house' });
  dicts.loadMany([file]);

  // Selection included punctuation; the trimmed rung matches.
  const [hit] = dicts.lookup(['«café»,', 'café']);
  assert.equal(hit.matchedCandidate, 'café');
  assert.equal(hit.definition, 'a coffee house');
});

test('Devanagari candidates are tried verbatim, in order', () => {
  resetDictionaries();
  const file = makeDictionary('nepali', { 'काठमाडौँ': 'the capital of Nepal' });
  dicts.loadMany([file]);

  const [hit] = dicts.lookup(['काठमाडौँ।', 'काठमाडौँ']);
  assert.equal(hit.matchedCandidate, 'काठमाडौँ');
  assert.equal(hit.definition, 'the capital of Nepal');
});

test('every enabled dictionary contributes at most one result, in priority order', () => {
  resetDictionaries();
  const first = makeDictionary('first', { water: 'H2O, from dictionary one' });
  const second = makeDictionary('second', { water: 'from dictionary two', Water: 'capitalised' });
  dicts.loadMany([first, second]);

  const results = dicts.lookup(['water', 'Water', 'WATER']);
  assert.equal(results.length, 2);
  assert.equal(results[0].dictName, 'first');
  assert.equal(results[1].dictName, 'second');
  // One hit per dictionary, even though "second" also has a capitalised key.
  assert.equal(results[1].matchedCandidate, 'water');

  // Reordering changes which dictionary answers first.
  dicts.reorder([second, first]);
  const reordered = dicts.lookup(['water']);
  assert.equal(reordered[0].dictName, 'second');
});

test('disabled dictionaries are skipped entirely', () => {
  resetDictionaries();
  const file = makeDictionary('toggleable', { tree: 'a plant' });
  dicts.loadMany([file]);
  assert.equal(dicts.lookup(['tree']).length, 1);

  dicts.toggle(file);
  assert.equal(dicts.lookup(['tree']).length, 0);

  dicts.toggle(file);
  assert.equal(dicts.lookup(['tree']).length, 1);
});

test('lookup rejects malformed candidate lists without throwing', () => {
  resetDictionaries();
  const file = makeDictionary('safe', { ok: 'fine' });
  dicts.loadMany([file]);

  assert.deepEqual(dicts.lookup('not an array'), []);
  assert.deepEqual(dicts.lookup(null), []);
  assert.deepEqual(dicts.lookup([]), []);
  assert.deepEqual(dicts.lookup(['', null, 42, {}]), []);
  // Oversized candidates are dropped rather than passed to the parser.
  assert.deepEqual(dicts.lookup(['x'.repeat(500)]), []);
});

test('a dictionary that fails to load is reported, not thrown', () => {
  resetDictionaries();
  const results = dicts.loadMany([path.join(userDataDir, 'does-not-exist.mdx')]);
  assert.equal(results.length, 1);
  assert.equal(results[0].success, false);
  assert.match(results[0].error, /not found/i);
});
