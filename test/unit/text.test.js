/**
 * Unicode text engine: tokenization, candidate ladder, search indexing.
 * Run with: node --test test/unit/
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  graphemes, segmentWords, countWords, trimEdges, collapseWhitespace,
  stripJoiners, hasDevanagari, isLatinToken, lookupCandidates,
  isAutoLookupCandidate, buildSearchIndex, findMatches, normalizeQuery,
  assessTextQuality,
} from '../../renderer/js/text.js';

// ── Grapheme integrity ────────────────────────────────────────────────────────

test('grapheme clusters keep Devanagari sequences intact', () => {
  // Conjunct क्ष + े then त्र — two clusters, never split mid-conjunct.
  assert.deepEqual(graphemes('क्षेत्र'), ['क्षे', 'त्र']);
  // Chandrabindu stays attached to its base cluster.
  assert.deepEqual(graphemes('काठमाडौँ'), ['का', 'ठ', 'मा', 'डौँ']);
  // Nukta and the following matra stay attached to their base consonant.
  assert.deepEqual(graphemes('क़िला'), ['क़ि', 'ला']);
  // A joiner never becomes a cluster of its own — it rides with its base.
  assert.deepEqual(graphemes('क‍ष'), ['क‍', 'ष']);
  // No cluster ever begins with a combining mark.
  for (const word of ['क्षेत्र', 'काठमाडौँ', 'क़िला', 'संस्कृत']) {
    for (const cluster of graphemes(word)) {
      assert.ok(!/^\p{M}/u.test(cluster), `cluster "${cluster}" starts with a mark`);
    }
  }
});

test('word segmentation keeps conjuncts and marks together', () => {
  const words = segmentWords('क्षेत्रफल बड़ा है।').filter(s => s.isWordLike).map(s => s.segment);
  assert.deepEqual(words, ['क्षेत्रफल', 'बड़ा', 'है']);

  const deva = segmentWords('काठमाडौँ नेपालको राजधानी हो ।')
    .filter(s => s.isWordLike).map(s => s.segment);
  assert.deepEqual(deva, ['काठमाडौँ', 'नेपालको', 'राजधानी', 'हो']);
});

test('Devanagari digits are word-like and stay grouped', () => {
  const segs = segmentWords('०१२३४५६७८९').filter(s => s.isWordLike).map(s => s.segment);
  assert.deepEqual(segs, ['०१२३४५६७८९']);
});

test('countWords counts word-like segments only', () => {
  assert.equal(countWords('hello world'), 2);
  assert.equal(countWords('काठमाडौँ नेपालको'), 2);
  assert.equal(countWords('।।।'), 0);
});

// ── Edge trimming ─────────────────────────────────────────────────────────────

test('trimEdges strips punctuation without touching interior marks', () => {
  assert.equal(trimEdges('«café»,'), 'café');
  assert.equal(trimEdges('(Paris)'), 'Paris');
  assert.equal(trimEdges('।नेपाल॥'), 'नेपाल');       // danda and double danda
  assert.equal(trimEdges('काठमाडौँ।'), 'काठमाडौँ');   // chandrabindu preserved
  assert.equal(trimEdges('क्षेत्र'), 'क्षेत्र');          // virama interior untouched
  assert.equal(trimEdges('क़िला'), 'क़िला');           // nukta preserved
  assert.equal(trimEdges("doesn't"), "doesn't");   // interior apostrophe kept
  assert.equal(trimEdges('‍नेपाल‌'), 'नेपाल'); // edge joiners stripped
});

test('collapseWhitespace normalizes runs but preserves words', () => {
  assert.equal(collapseWhitespace('  हिन्दी   और \n संस्कृत '), 'हिन्दी और संस्कृत');
});

test('stripJoiners removes ZWJ and ZWNJ only', () => {
  assert.equal(stripJoiners('क‍ष'), 'कष');
  assert.equal(stripJoiners('क्ष'), 'क्ष'); // virama is not a joiner
});

// ── Script detection ──────────────────────────────────────────────────────────

test('script detection distinguishes Devanagari from Latin', () => {
  assert.equal(hasDevanagari('नेपाल'), true);
  assert.equal(hasDevanagari('Paris'), false);
  assert.equal(isLatinToken('café'), true);
  assert.equal(isLatinToken('NASA'), true);
  assert.equal(isLatinToken('नेपाल'), false);
  assert.equal(isLatinToken('café नेपाल'), false);
});

// ── Candidate ladder ──────────────────────────────────────────────────────────

test('candidate ladder starts with the exact selection', () => {
  assert.equal(lookupCandidates('Paris')[0], 'Paris');
  assert.equal(lookupCandidates('«café»,')[0], '«café»,');
  assert.equal(lookupCandidates('काठमाडौँ।')[0], 'काठमाडौँ।');
});

test('proper-case Latin entries stay discoverable', () => {
  // Exact form first so a dictionary keyed on "Paris"/"NASA" hits before
  // any folded variant.
  assert.deepEqual(lookupCandidates('Paris'), ['Paris', 'paris', 'PARIS']);
  assert.deepEqual(lookupCandidates('NASA'), ['NASA', 'nasa', 'Nasa']);
  assert.deepEqual(lookupCandidates('(Paris)'), ['(Paris)', 'Paris', 'paris', 'PARIS']);
});

test('accented Latin survives every rung of the ladder', () => {
  const c = lookupCandidates('«café»,');
  assert.ok(c.includes('café'));
  assert.ok(c.includes('Café'));
  assert.ok(c.includes('CAFÉ'));
  assert.ok(!c.some(x => x.includes('caf ') || x === 'caf'));
});

test('Devanagari never gets Latin case variants', () => {
  const c = lookupCandidates('काठमाडौँ।');
  assert.deepEqual(c, ['काठमाडौँ।', 'काठमाडौँ']);
  for (const candidate of c) {
    assert.equal(candidate, candidate.normalize('NFC').length === candidate.length
      ? candidate : candidate);
  }
});

test('NFC variants are offered for precomposed nukta forms', () => {
  // U+0958 (QA) is a composition exclusion: NFC decomposes it to क + nukta,
  // so both spellings must be tried — MDX headwords use either.
  const precomposed = 'क़िला';
  const c = lookupCandidates(precomposed);
  assert.equal(c[0], precomposed);
  assert.ok(c.some(x => x === precomposed.normalize('NFC')));
  assert.notEqual(precomposed, precomposed.normalize('NFC'));
});

test('ZWJ/ZWNJ variants are offered without disturbing the exact form', () => {
  const c = lookupCandidates('क‍ष');
  assert.equal(c[0], 'क‍ष');
  assert.ok(c.includes('कष'));
});

test('candidate ladder is deduplicated and bounded', () => {
  const c = lookupCandidates('नेपाल');
  assert.equal(new Set(c).size, c.length);
  assert.ok(lookupCandidates('x'.repeat(500)).every(x => x.length <= 120));
});

test('phrases are supported as candidates', () => {
  const c = lookupCandidates('  हिन्दी और  संस्कृत ');
  assert.equal(c[0], 'हिन्दी और संस्कृत');
});

// ── Auto-lookup gating ────────────────────────────────────────────────────────

test('auto-lookup accepts words and short phrases, rejects long selections', () => {
  assert.equal(isAutoLookupCandidate('काठमाडौँ'), true);
  assert.equal(isAutoLookupCandidate('café'), true);
  assert.equal(isAutoLookupCandidate('the quick brown fox jumps'), true);
  assert.equal(isAutoLookupCandidate('a '.repeat(60)), false);      // too long
  assert.equal(isAutoLookupCandidate('one two three four five six seven'), false);
  assert.equal(isAutoLookupCandidate('   '), false);
  assert.equal(isAutoLookupCandidate('।॥—'), false);                // no letters
});

// ── Search index ──────────────────────────────────────────────────────────────

test('search matches Devanagari including conjuncts', () => {
  const text = 'प्रज्ञा और क्षेत्र जैसे संयुक्ताक्षर सही रहने चाहिए ।';
  const index = buildSearchIndex(text);
  assert.equal(findMatches(index, 'क्षेत्र').length, 1);
  assert.equal(findMatches(index, 'प्रज्ञा').length, 1);
  const m = findMatches(index, 'क्षेत्र')[0];
  assert.equal(text.slice(m.start, m.end), 'क्षेत्र');
});

test('search is case- and normalization-insensitive for Latin', () => {
  const index = buildSearchIndex('A café in Paris, studied by NASA.');
  assert.equal(findMatches(index, 'CAFÉ').length, 1);
  assert.equal(findMatches(index, 'paris').length, 1);
  assert.equal(findMatches(index, 'nasa').length, 1);
});

test('a match is never empty and never cuts a grapheme cluster', () => {
  // Searching a prefix that ends inside a cluster used to produce start ===
  // end: the result was counted but highlighted nothing.
  const cases = [
    ['क़िला', 'क़'],       // precomposed nukta, decomposed by NFC
    ['क़िला', 'क'],        // base consonant of a nukta cluster
    ['नेपाल', 'नेप'],      // prefix ending before a matra
    ['İstanbul', 'i'],    // İ lowercases to two code points
    ['क्षेत्र', 'क्ष'],       // conjunct prefix
  ];
  for (const [haystack, query] of cases) {
    const matches = findMatches(buildSearchIndex(haystack), query);
    assert.equal(matches.length, 1, `expected one match for ${query} in ${haystack}`);
    const [{ start, end }] = matches;
    assert.ok(end > start, `empty match for ${query} in ${haystack}`);
    const slice = haystack.slice(start, end);
    assert.ok(slice.length > 0);
    // The slice must consist of whole clusters of the haystack.
    const clusters = graphemes(haystack);
    let offset = 0;
    const boundaries = new Set([0]);
    for (const c of clusters) { offset += c.length; boundaries.add(offset); }
    assert.ok(boundaries.has(start), `start ${start} is inside a cluster`);
    assert.ok(boundaries.has(end), `end ${end} is inside a cluster`);
  }
});

test('search offsets map back to the original string exactly', () => {
  const text = 'İstanbul and क़िला and café';
  const index = buildSearchIndex(text);
  for (const query of ['café', 'क़िला']) {
    const [m] = findMatches(index, query);
    assert.ok(m, `expected a match for ${query}`);
    assert.equal(text.slice(m.start, m.end), query);
  }
});

test('search finds every occurrence in order', () => {
  const index = buildSearchIndex('काठमाडौँ x काठमाडौँ y काठमाडौँ');
  const matches = findMatches(index, 'काठमाडौँ');
  assert.equal(matches.length, 3);
  assert.ok(matches[0].start < matches[1].start && matches[1].start < matches[2].start);
});

test('search finds words split across adjacent text items', () => {
  // pdf.js splits items on layout heuristics; viewer.js concatenates item
  // strings with no separator so a split word stays findable.
  const index = buildSearchIndex(['हैं ।प्र', 'ज्ञा और'].join(''));
  assert.equal(findMatches(index, 'प्रज्ञा').length, 1);
});

test('empty and whitespace queries match nothing', () => {
  const index = buildSearchIndex('नेपाल');
  assert.deepEqual(findMatches(index, ''), []);
  assert.equal(normalizeQuery(''), '');
});

// ── Text quality ──────────────────────────────────────────────────────────────

test('text quality classification', () => {
  assert.equal(assessTextQuality('This is a normal sentence with plenty of letters.'), 'ok');
  assert.equal(assessTextQuality('काठमाडौँ नेपालको राजधानी हो ।'), 'ok');
  assert.equal(assessTextQuality(''), 'empty');
  assert.equal(assessTextQuality('   \n  '), 'empty');
  // Chromium-style broken ToUnicode: conjuncts come back as NUL.
  assert.equal(assessTextQuality(' लॉस पर  ण द तावेज     '), 'garbled');
  assert.equal(assessTextQuality('���� abcdefgh ����'), 'garbled');
});
