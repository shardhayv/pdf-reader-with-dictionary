/**
 * Per-book glossary builder: Unicode extraction, ranking, quality gates, and
 * non-destructive regeneration. These are the high-value workflow guarantees
 * for AI-assisted English/Devanagari glossaries.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FORMAT,
  FORMAT_VERSION,
  assessTextQuality,
  buildGlossary,
  collectCandidates,
  contextFor,
  isPlausibleWord,
  joinTextItems,
  mergeGlossary,
  validateOptions,
  writeAtomic,
} from '../../scripts/glossary-builder.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '..', 'fixtures');

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-builder-'));
}

test('default ranking keeps useful English and short Devanagari words', () => {
  const pages = [{
    page: 1,
    text: [
      'और है यह सामान्य पाठ है ।',
      'प्रज्ञा क्षेत्र संस्कृत हिन्दी काठमाडौँ संयुक्ताक्षर ।',
      'A liminal state-of-the-art idea can be ineffable.',
      'The mimetype appears again: mimetype and mimetype.',
    ].join(' '),
    recovered: [],
  }];
  const { candidates } = collectCandidates(pages);
  const byWord = new Map(candidates.map(entry => [entry.word, entry]));

  for (const word of ['प्रज्ञा', 'क्षेत्र', 'संस्कृत', 'हिन्दी', 'काठमाडौँ', 'संयुक्ताक्षर']) {
    assert.ok(byWord.has(word), `missing Devanagari candidate ${word}`);
  }
  assert.ok(byWord.has('liminal'));
  assert.ok(byWord.has('ineffable'));
  assert.ok(byWord.has('state-of-the-art'), 'hyphenated terms should stay intact');
  assert.equal(byWord.get('mimetype').count, 3, 'recurring technical terms must not be filtered out');
  assert.equal(byWord.has('और'), false, 'known Devanagari function words should be filtered');
  assert.equal(byWord.has('है'), false);
});

test('connector rules keep real compounds but reject extraction debris', () => {
  for (const word of ["reader's", 'reader’s', 'state-of-the-art', 'दुःख-दर्शन']) {
    assert.equal(isPlausibleWord(word), true, word);
  }
  for (const debris of ['-broken', 'broken-', 'two--words', 'above.the', 'name_thing', 'abc123']) {
    assert.equal(isPlausibleWord(debris), false, debris);
  }
});

test('a synthetic space after Devanagari nukta is recovered without joining normal words', () => {
  const [{ text, recovered }] = [joinTextItems([{
    str: 'क़ लम और की किताब', transform: [1, 0, 0, 1, 0, 0], width: 100, height: 12,
  }])];
  assert.equal(text, 'क़ लम और की किताब');
  assert.deepEqual(recovered.map(item => item.word), ['क़लम']);

  const words = new Set(collectCandidates([{ page: 1, text, recovered }], {
    keepCommon: true, minDevanagariLength: 1,
  })
    .candidates.map(entry => entry.word));
  assert.ok(words.has('क़लम'));
  assert.equal(words.has('लम'), false, 'the broken right fragment leaked into the draft');
  assert.ok(words.has('की'));
  assert.ok(words.has('किताब'));
  assert.equal(words.has('कीकिताब'), false, 'a legitimate phrase was incorrectly joined');
});

test('text-quality gates distinguish scans from corrupted character maps', () => {
  assert.equal(assessTextQuality(''), 'empty');
  assert.equal(assessTextQuality('   1 2 3   '), 'empty');
  assert.equal(assessTextQuality('\0\0\0\0\0\0\0\0\0\0'), 'garbled');
  assert.equal(assessTextQuality('English and देवनागरी both extract correctly.'), 'ok');
});

test('context fallback never slices through a Devanagari grapheme', () => {
  const text = 'आरम्भ ' + 'काठमाडौँ '.repeat(30) + 'समाप्त';
  const index = text.indexOf('काठमाडौँ', 50);
  const context = contextFor(text, index, 'काठमाडौँ'.length, 45);
  assert.match(context, /^…/);
  assert.match(context, /…$/);
  const body = context.replace(/^…|…$/g, '');
  const start = text.indexOf(body);
  assert.ok(start >= 0);
  const segmenter = new Intl.Segmenter(['hi', 'ne'], { granularity: 'grapheme' });
  const boundaries = new Set([text.length]);
  for (const part of segmenter.segment(text)) boundaries.add(part.index);
  assert.ok(boundaries.has(start), 'context starts inside a grapheme');
  assert.ok(boundaries.has(start + body.length), 'context ends inside a grapheme');
});

test('merge preserves AI-authored fields and manual entries while refreshing extraction data', () => {
  const existing = {
    format: FORMAT,
    version: FORMAT_VERSION,
    name: 'My carefully named glossary',
    customRoot: { keep: true },
    entries: [
      {
        word: 'liminal',
        definition: '<b>Authored</b> definition',
        aliases: ['liminality'],
        example: 'A hand-picked example.',
        privateNote: 'keep me',
        count: 1,
      },
      { word: 'manual-only', definition: 'Added by hand' },
    ],
  };
  const generated = {
    format: FORMAT,
    version: FORMAT_VERSION,
    name: 'Generated name',
    source: { file: 'book.pdf', fingerprint: 'abc' },
    created: '2026-08-02',
    updated: '2026-08-02',
    entries: [
      { word: 'liminal', definition: '', aliases: [], count: 9, page: 7, example: 'Generated.', occurrences: [] },
      { word: 'ineffable', definition: '', aliases: [], count: 2, page: 8, occurrences: [] },
    ],
  };

  const merged = mergeGlossary(existing, generated);
  assert.equal(merged.name, existing.name);
  assert.deepEqual(merged.customRoot, { keep: true });
  const liminal = merged.entries.find(entry => entry.word === 'liminal');
  assert.equal(liminal.definition, '<b>Authored</b> definition');
  assert.deepEqual(liminal.aliases, ['liminality']);
  assert.equal(liminal.example, 'A hand-picked example.');
  assert.equal(liminal.privateNote, 'keep me');
  assert.equal(liminal.count, 9);
  assert.ok(merged.entries.some(entry => entry.word === 'manual-only'));
  assert.ok(merged.entries.some(entry => entry.word === 'ineffable'));
  assert.equal(merged.merge.preservedDefinitions, 2);
  assert.equal(merged.merge.addedEntries, 1);
});

test('invalid builder options fail loudly instead of producing an empty draft', () => {
  assert.throws(() => validateOptions({ minDevanagariLength: 0 }), /min-devanagari/i);
  assert.throws(() => validateOptions({ minLatinLength: Number.NaN }), /min-latin/i);
  assert.throws(() => validateOptions({ limit: 0 }), /limit/i);
  assert.throws(() => validateOptions({ language: 'not a tag!' }), /language/i);
});

test('the real Devanagari fixture yields conjuncts and short headwords intact', async () => {
  const result = await buildGlossary(path.join(fixtures, 'devanagari.pdf'), { listOnly: true });
  const words = new Set(result.candidates.map(entry => entry.word));
  for (const word of ['काठमाडौँ', 'हिन्दी', 'संस्कृत', 'प्रज्ञा', 'क्षेत्र', 'संयुक्ताक्षर', 'क़लम']) {
    assert.ok(words.has(word), `fixture extraction lost ${word}`);
  }
  assert.equal(words.has('लम'), false, 'fixture leaked a split-word fragment');
  assert.equal(result.extracted.quality, 'ok');
});

test('scanned and broken-mapping PDFs refuse to create misleading glossaries', async () => {
  const dir = temporaryDirectory();
  const scannedOutput = path.join(dir, 'scanned.json');
  const garbledOutput = path.join(dir, 'garbled.json');
  await assert.rejects(
    buildGlossary(path.join(fixtures, 'scanned.pdf'), { output: scannedOutput }),
    /no extractable text|scanned/i,
  );
  await assert.rejects(
    buildGlossary(path.join(fixtures, 'garbled.pdf'), { output: garbledOutput }),
    /broken text mappings|corrupted/i,
  );
  assert.equal(fs.existsSync(scannedOutput), false);
  assert.equal(fs.existsSync(garbledOutput), false);
});

test('regeneration is atomic and preserves completed definitions with a backup', async () => {
  const dir = temporaryDirectory();
  const input = path.join(fixtures, 'devanagari.pdf');
  const output = path.join(dir, 'books', 'devanagari.glossary.json');

  const first = await buildGlossary(input, { output, language: 'hi' });
  assert.equal(first.existed, false);
  const draft = JSON.parse(fs.readFileSync(output, 'utf8'));
  // -o points outside the PDF directory; source.file must still resolve back
  // to the correct book and not merely contain its basename.
  assert.equal(path.resolve(path.dirname(output), draft.source.file), path.resolve(input));
  const authored = draft.entries.find(entry => entry.word === 'काठमाडौँ');
  authored.definition = 'नेपालको राजधानी — authored by AI and reviewed by me.';
  authored.aliases = ['काठमाडौं'];
  authored.myField = 'must survive';
  fs.writeFileSync(output, `${JSON.stringify(draft, null, 2)}\n`);

  const second = await buildGlossary(input, { output, language: 'hi' });
  assert.equal(second.existed, true);
  assert.ok(second.backupPath);
  assert.equal(fs.existsSync(second.backupPath), true);
  const updated = JSON.parse(fs.readFileSync(output, 'utf8'));
  const kept = updated.entries.find(entry => entry.word === 'काठमाडौँ');
  assert.match(kept.definition, /authored by AI/);
  assert.deepEqual(kept.aliases, ['काठमाडौं']);
  assert.equal(kept.myField, 'must survive');
});

test('atomic writer refuses to overwrite the source PDF or a same-inode alias', () => {
  const dir = temporaryDirectory();
  const input = path.join(dir, 'book.pdf');
  fs.writeFileSync(input, '%PDF-1.7\n');
  assert.throws(() => writeAtomic(input, { entries: [] }, { inputPath: input }), /refusing/i);

  const hardlink = path.join(dir, 'book.glossary.json');
  fs.linkSync(input, hardlink);
  assert.throws(() => writeAtomic(hardlink, { entries: [] }, { inputPath: input }), /refusing/i);
  assert.equal(fs.readFileSync(input, 'utf8'), '%PDF-1.7\n');
});
