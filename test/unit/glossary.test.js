/**
 * JSON glossary format: parsing, validation, and lookup.
 * main/glossary.js has no Electron dependency, so it tests directly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { FORMAT, FORMAT_VERSION, Glossary, isGlossaryPath } = require('../../main/glossary.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-glossary-'));
let counter = 0;

function write(value) {
  const file = path.join(dir, `g${counter++}.json`);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

const define = (word, definition, extra = {}) => ({ word, definition, ...extra });

test('a minimal glossary loads and looks up', () => {
  const g = new Glossary(write({
    name: 'Book glossary',
    entries: [define('chutnification', "Rushdie's coinage for preserving the past")],
  }));
  assert.equal(g.title, 'Book glossary');
  assert.equal(g.size, 1);

  const hit = g.lookup('chutnification');
  assert.equal(hit.keyText, 'chutnification');
  assert.match(hit.definition, /Rushdie/);

  // A miss reports a null definition, matching the MDX backend's contract.
  assert.equal(g.lookup('absent').definition, null);
});

test('a bare array of entries is accepted', () => {
  const g = new Glossary(write([define('word', 'meaning')]));
  assert.equal(g.lookup('word').definition, 'meaning');
});

test('aliases resolve to the same entry', () => {
  const g = new Glossary(write({
    entries: [define('काठमाडौँ', 'Kathmandu', { aliases: ['काठमाडौं', 'काठमांडू'] })],
  }));
  for (const key of ['काठमाडौँ', 'काठमाडौं', 'काठमांडू']) {
    assert.equal(g.lookup(key).definition, 'Kathmandu', `alias ${key} failed`);
    // The headword is reported, not the alias that matched.
    assert.equal(g.lookup(key).keyText, 'काठमाडौँ');
  }
});

test('both the authored and NFC spellings are indexed', () => {
  // U+0958 (precomposed QA) is a composition exclusion, so NFC decomposes
  // it to क + nukta. A glossary authored with either spelling must match a
  // lookup arriving with the other. Written as escapes because the two
  // forms are visually identical in a source file.
  const precomposed = 'क़िला';   // क़िला, precomposed
  const decomposed = precomposed.normalize('NFC');  // क + U+093C + …
  assert.notEqual(precomposed, decomposed, 'expected NFC to change this string');

  const g = new Glossary(write({ entries: [define(precomposed, 'a fort')] }));
  assert.equal(g.lookup(precomposed).definition, 'a fort');
  assert.equal(g.lookup(decomposed).definition, 'a fort');
});

test('optional example text is carried through', () => {
  const g = new Glossary(write({
    entries: [define('संयुक्ताक्षर', 'conjunct consonant', { example: 'प्रज्ञा और क्षेत्र जैसे संयुक्ताक्षर' })],
  }));
  assert.match(g.lookup('संयुक्ताक्षर').example, /प्रज्ञा/);
});

test('entries without a usable definition are skipped, not counted', () => {
  const g = new Glossary(write({
    entries: [
      define('kept', 'has a definition'),
      define('blank', ''),          // draft entry not yet filled in
      define('spaces', '   '),
      { word: 'nodef' },
      { definition: 'no word' },
      null,
      'not an object',
      define('', 'empty word'),
    ],
  }));
  assert.equal(g.size, 1);
  assert.equal(g.totalEntries, 4);
  assert.equal(g.lookup('kept').definition, 'has a definition');
  assert.equal(g.lookup('blank').definition, null);
  assert.equal(g.lookup('nodef').definition, null);
});

test('the first definition of a repeated headword wins', () => {
  const g = new Glossary(write({
    entries: [define('word', 'first'), define('word', 'second')],
  }));
  assert.equal(g.lookup('word').definition, 'first');
});

test('malformed files fail with a message rather than throwing something opaque', () => {
  assert.throws(() => new Glossary(write('{ not json')), /valid JSON/i);
  assert.throws(() => new Glossary(write({ name: 'x' })), /entries/i);
  assert.throws(() => new Glossary(write({ entries: 'nope' })), /entries/i);
  assert.throws(() => new Glossary(write({ entries: [] })), /valid glossary headwords/i);

  // A generated draft is useful before any definition has been filled. It
  // loads cleanly, reports draft counts, and simply returns no hits yet.
  const draft = new Glossary(write({ entries: [define('a', '')] }));
  assert.equal(draft.size, 0);
  assert.equal(draft.totalEntries, 1);
  assert.equal(draft.lookup('a').definition, null);
});

test('versioned glossaries reject unknown formats, versions, and scope typos', () => {
  const base = { format: FORMAT, version: FORMAT_VERSION, entries: [define('word', 'meaning')] };
  assert.equal(new Glossary(write(base)).lookup('word').definition, 'meaning');
  assert.throws(() => new Glossary(write({ ...base, format: 'another-app' })), /format/i);
  assert.throws(() => new Glossary(write({ ...base, version: 99 })), /version/i);
  assert.throws(() => new Glossary(write({ ...base, scope: 'bok' })), /scope/i);
  assert.throws(() => new Glossary(write({ ...base, scope: 'book' })), /source/i);
});

test('a generated glossary activates only for its own PDF', () => {
  const book = path.join(dir, 'किताब.pdf');
  const other = path.join(dir, 'other.pdf');
  fs.writeFileSync(book, '%PDF-1.7\n');
  fs.writeFileSync(other, '%PDF-1.7\n');
  const g = new Glossary(write({
    format: FORMAT,
    version: FORMAT_VERSION,
    scope: 'book',
    source: { file: path.basename(book), fingerprint: 'ABC123' },
    entries: [define('प्रज्ञा', 'wisdom')],
  }));

  assert.equal(g.scope, 'book');
  assert.equal(g.matchesDocument({ path: book, fingerprint: '' }), true);
  assert.equal(g.matchesDocument({ path: other, fingerprint: 'abc123' }), true);
  assert.equal(g.matchesDocument({ path: other, fingerprint: 'different' }), false);
  assert.equal(g.matchesDocument(null), false);
});

test('legacy source strings are book-scoped while source-less glossaries remain global', () => {
  const book = path.join(dir, 'legacy.pdf');
  fs.writeFileSync(book, '%PDF-1.7\n');
  const scoped = new Glossary(write({
    source: path.basename(book),
    entries: [define('term', 'book meaning')],
  }));
  const global = new Glossary(write({
    entries: [define('term', 'general meaning')],
  }));
  assert.equal(scoped.scope, 'book');
  assert.equal(scoped.matchesDocument(book), true);
  assert.equal(global.scope, 'global');
  assert.equal(global.matchesDocument(null), true);
});

test('occurrences, count, page, and language survive lookup', () => {
  const g = new Glossary(write({
    language: 'ne',
    entries: [define('काठमाडौँ', 'नेपालको राजधानी', {
      count: 7,
      occurrences: [
        { page: 3, text: 'काठमाडौँ नेपालको राजधानी हो ।' },
        { page: 19, text: 'उनी काठमाडौँ फर्किए ।' },
      ],
    })],
  }));
  const hit = g.lookup('काठमाडौँ');
  assert.equal(hit.language, 'ne');
  assert.equal(hit.count, 7);
  assert.equal(hit.page, 3);
  assert.equal(hit.example, 'काठमाडौँ नेपालको राजधानी हो ।');
  assert.equal(hit.occurrences.length, 2);
});

test('oversized values are clamped rather than trusted', () => {
  const g = new Glossary(write({
    name: 'n'.repeat(500),
    entries: [
      define('huge', 'd'.repeat(200_000), { example: 'e'.repeat(9000) }),
      define('x'.repeat(500), 'word too long'),
    ],
  }));
  assert.ok(g.title.length <= 200);
  const hit = g.lookup('huge');
  assert.ok(hit.definition.length <= 64 * 1024);
  assert.ok(hit.example.length <= 2000);
  // The over-long headword was rejected outright.
  assert.equal(g.size, 1);
});

test('definitions are returned verbatim — sanitizing is the renderer\'s job', () => {
  // The glossary must not pretend to sanitize; the renderer applies exactly
  // the same DOMPurify policy it applies to MDX content.
  const hostile = '<img src=x onerror=alert(1)>text';
  const g = new Glossary(write({ entries: [define('w', hostile)] }));
  assert.equal(g.lookup('w').definition, hostile);
});

test('isGlossaryPath distinguishes glossaries from MDX', () => {
  assert.equal(isGlossaryPath('/books/a.json'), true);
  assert.equal(isGlossaryPath('/books/a.glossary.json'), true);
  assert.equal(isGlossaryPath('/books/A.JSON'), true);
  assert.equal(isGlossaryPath('/books/a.mdx'), false);
  assert.equal(isGlossaryPath('/books/a.json.mdx'), false);
});
