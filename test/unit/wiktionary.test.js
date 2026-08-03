/**
 * Wiktionary tier: Parsoid HTML normalization and the status contract.
 *
 * The renderer's DOMPurify pass is the security boundary, so these tests are
 * about usefulness, not safety: internal wiki links have to survive as
 * entry:// cross-references, parser bookkeeping has to go, and a popup must
 * never be handed all 72 senses of "run".
 *
 * electron is stubbed through the require cache so the module can run outside
 * an Electron process; net.fetch is replaced per test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let fetchImpl = async () => { throw new Error('no fetch configured'); };
let online = true;

require.cache[require.resolve('electron')] = {
  id: 'electron', filename: 'electron', loaded: true,
  exports: {
    app: { getVersion: () => '2.1.1' },
    net: {
      fetch: (...args) => fetchImpl(...args),
      isOnline: () => online,
    },
  },
};

const { lookup, normalizeHtml, rewriteHref, buildSections } =
  require('../../main/wiktionary.js');

/** Minimal stand-in for the fetch Response surface the module touches. */
function response(status, json) {
  return { status, ok: status >= 200 && status < 300, json: async () => json };
}

function section(partOfSpeech, definitions, language = 'English') {
  return { partOfSpeech, language, definitions: definitions.map(d => ({ definition: d })) };
}

// ── rewriteHref ───────────────────────────────────────────────────────────────

test('internal wiki links become entry:// cross-references', () => {
  assert.equal(rewriteHref('/wiki/short'), 'entry://short');
  assert.equal(rewriteHref('./short'), 'entry://short');
  assert.equal(rewriteHref('/wiki/water#English'), 'entry://water');
  assert.equal(rewriteHref('/wiki/free_will'), 'entry://free%20will');
});

test('protocol-relative interwiki links become https', () => {
  assert.equal(rewriteHref('//en.wikipedia.org/wiki/Dharma'),
    'https://en.wikipedia.org/wiki/Dharma');
  assert.equal(rewriteHref('https://example.org/x'), 'https://example.org/x');
});

test('non-headword namespaces and empty hrefs are dropped', () => {
  assert.equal(rewriteHref('/wiki/Appendix:Glossary'), '');
  assert.equal(rewriteHref('/wiki/Reconstruction:Proto-Indo-European/wed-'), '');
  assert.equal(rewriteHref('#cite_note-1'), '');
  assert.equal(rewriteHref(''), '');
  assert.equal(rewriteHref('   '), '');
});

// ── normalizeHtml ─────────────────────────────────────────────────────────────

test('normalizeHtml rewrites links and strips parser bookkeeping', () => {
  const raw = 'Lasting for a <a rel="mw:WikiLink" href="/wiki/short" title="short">short</a> ' +
    'period of <a rel="mw:WikiLink" href="/wiki/time" title="time">time</a>.';
  const out = normalizeHtml(raw);
  assert.match(out, /href="entry:\/\/short"/);
  assert.match(out, /href="entry:\/\/time"/);
  assert.doesNotMatch(out, /rel=/);
  assert.match(out, /title="short"/); // title survives; the popup allows it
});

test('normalizeHtml drops style blocks, link tags and transclusion markers', () => {
  const raw = '<span class="usage-label-sense" about="#mwt16" typeof="mw:Transclusion"></span> ' +
    'Existing for only one day.' +
    '<style data-mw-deduplicate="TemplateStyles:r90144991">.defdate{font-size:smaller}</style>';
  const out = normalizeHtml(raw);
  assert.doesNotMatch(out, /<style/);
  assert.doesNotMatch(out, /about=/);
  assert.doesNotMatch(out, /typeof=/);
  assert.doesNotMatch(out, /font-size/);
  assert.match(out, /Existing for only one day\./);
});

test('normalizeHtml flattens links it cannot map, keeping the text', () => {
  const out = normalizeHtml('see <a href="/wiki/Appendix:Foo">Appendix</a> here');
  assert.doesNotMatch(out, /href=/);
  assert.match(out, /Appendix/);
});

// ── buildSections ─────────────────────────────────────────────────────────────

test('the preferred language is ordered ahead of the rest', () => {
  const sections = buildSections({
    sa: [section('Noun', ['stupidity'], 'Sanskrit')],
    hi: [section('Noun', ['water'], 'Hindi')],
    mr: [section('Noun', ['water'], 'Marathi')],
  }, 'hi');
  assert.equal(sections[0].language, 'Hindi');
});

test('English is preferred when the reader has no other preference', () => {
  const sections = buildSections({
    sa: [section('Noun', ['x'], 'Sanskrit')],
    en: [section('Noun', ['y'], 'English')],
  }, 'en');
  assert.equal(sections[0].lang, 'en');
});

test('senses and sections are capped so a popup stays readable', () => {
  const many = Array.from({ length: 72 }, (_, i) => `sense ${i}`);
  const sections = buildSections({
    en: Array.from({ length: 10 }, () => section('Verb', many)),
  }, 'en');
  assert.ok(sections.length <= 6, `got ${sections.length} sections`);
  assert.ok(sections[0].senses.length <= 8, `got ${sections[0].senses.length} senses`);
});

test('the "other" bucket carries no language code', () => {
  const sections = buildSections({ other: [section('Noun', ['water'], '')] }, 'en');
  assert.equal(sections[0].lang, '');
});

test('sections whose senses are all empty are dropped', () => {
  const sections = buildSections({
    en: [section('Noun', ['<style>a{}</style>']), section('Verb', ['real sense'])],
  }, 'en');
  assert.equal(sections.length, 1);
  assert.equal(sections[0].partOfSpeech, 'Verb');
});

// ── lookup: status contract ───────────────────────────────────────────────────

test('a page with definitions is a hit', async () => {
  fetchImpl = async () => response(200, { en: [section('Adjective', ['Lasting a short time.'])] });
  const result = await lookup('en', 'ephemeral');
  assert.equal(result.status, 'hit');
  assert.equal(result.word, 'ephemeral');
  assert.equal(result.sections[0].partOfSpeech, 'Adjective');
  assert.equal(result.url, 'https://en.wiktionary.org/wiki/ephemeral');
});

test('404 is a miss, not an error', async () => {
  fetchImpl = async () => response(404, {});
  assert.equal((await lookup('en', 'zzqxfoobar')).status, 'miss');
});

test('a 200 with no usable sections is a miss', async () => {
  fetchImpl = async () => response(200, {});
  assert.equal((await lookup('en', 'x')).status, 'miss');
});

test('server errors and malformed bodies are errors', async () => {
  fetchImpl = async () => response(503, {});
  assert.equal((await lookup('en', 'x')).status, 'error');

  fetchImpl = async () => ({ status: 200, ok: true, json: async () => { throw new Error('bad json'); } });
  assert.equal((await lookup('en', 'x')).status, 'error');
});

test('a failed request offline reports offline, not error', async () => {
  fetchImpl = async () => { throw new Error('network down'); };
  online = false;
  assert.equal((await lookup('en', 'x')).status, 'offline');
  online = true;
  assert.equal((await lookup('en', 'x')).status, 'error');
});

test('an empty or whitespace selection never reaches the network', async () => {
  fetchImpl = async () => { throw new Error('should not be called'); };
  assert.equal((await lookup('en', '   ')).status, 'miss');
  assert.equal((await lookup('en', null)).status, 'miss');
});

test('the requested word is length-capped and percent-encoded', async () => {
  let seen = '';
  fetchImpl = async (url) => { seen = url; return response(404, {}); };
  await lookup('en', `${'a'.repeat(500)} b`);
  const encoded = new URL(seen).pathname.split('/').pop();
  assert.ok(decodeURIComponent(encoded).length <= 128);

  await lookup('en', 'free will');
  assert.match(seen, /free%20will/);
});
