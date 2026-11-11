/**
 * Testable core of the per-book glossary builder.
 *
 * The CLI wrapper is scripts/make-glossary.js. Keeping extraction, ranking and
 * merging here lets the exact workflow be regression-tested instead of merely
 * testing the much simpler JSON reader.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PDFJS_ROOT = path.dirname(require.resolve('pdfjs-dist/package.json'));

export const FORMAT = 'gloss-glossary';
export const FORMAT_VERSION = 1;
export const DEFAULTS = Object.freeze({
  minLatinLength: 4,
  minDevanagariLength: 2,
  minOtherLength: 4,
  maxCount: Infinity,
  limit: 5000,
  maxOccurrences: 3,
  keepCommon: false,
  dropNames: false,
  forceGarbled: false,
  language: '',
  name: '',
  exclude: '',
  listOnly: false,
});

const wordSegmenter = new Intl.Segmenter(['hi', 'ne', 'en'], { granularity: 'word' });
const graphemeSegmenter = new Intl.Segmenter(['hi', 'ne', 'en'], { granularity: 'grapheme' });
const sentenceSegmenter = new Intl.Segmenter(['hi', 'ne', 'en'], { granularity: 'sentence' });

const asDirectoryPath = (directory) => `${directory}${path.sep}`;

export function graphemes(text) {
  return [...graphemeSegmenter.segment(text)].map(part => part.segment);
}

export function scriptOf(word) {
  if (/\p{Script=Devanagari}/u.test(word)) return 'devanagari';
  if (/\p{Script=Latin}/u.test(word)) return 'latin';
  return 'other';
}

export function canonicalHeadword(word) {
  const normalized = String(word || '').trim().normalize('NFC');
  return scriptOf(normalized) === 'latin' ? normalized.toLocaleLowerCase() : normalized;
}

export function assessTextQuality(text) {
  const letters = (text.match(/[\p{L}\p{N}]/gu) || []).length;
  const bad = (text.match(/[\uFFFD\uE000-\uF8FF\u0000-\u0008\u000B\u000E-\u001F]/gu) || []).length;
  if (bad >= 8 && bad / Math.max(1, letters + bad) > 0.05) return 'garbled';
  if (letters < 8) return 'empty';
  return 'ok';
}

function itemBoundary(previous, item) {
  if (!previous) return '';
  if (/\s$/.test(previous.str) || /^\s/.test(item.str)) return '';
  if (previous.hasEOL) return ' ';
  const sameLine = Math.abs(item.transform[5] - previous.transform[5]) < 2;
  if (!sameLine) return ' ';
  const gap = item.transform[4] - (previous.transform[4] + previous.width);
  const scale = Math.max(1, Math.min(previous.height || 10, item.height || 10));
  return gap > Math.max(0.8, scale * 0.08) ? ' ' : '';
}

function edgeWord(text, side) {
  const pattern = side === 'end'
    ? /([\p{L}\p{M}\p{Cf}]+)$/u
    : /^([\p{L}\p{M}\p{Cf}]+)/u;
  return text.match(pattern)?.[1] || '';
}

/**
 * Recover a conservative alternate word at a suspicious item boundary.
 *
 * Some PDFs map the first cluster of a Devanagari word to the previous text
 * item (the regression fixture exposes प्र + ज्ञा this way). The normal text
 * still keeps the line break; this merely adds the joined form as a candidate.
 */
function recoverBoundaryWord(previous, item, separator) {
  if (!previous || !separator) return '';
  const right = edgeWord(item.str, 'start');
  if (!right) return '';

  const hyphenated = previous.str.match(/([\p{L}\p{M}\p{Cf}]+)-$/u)?.[1] || '';
  if (hyphenated && scriptOf(hyphenated) === 'latin' && scriptOf(right) === 'latin') {
    return `${hyphenated}${right}`.normalize('NFC');
  }

  const left = edgeWord(previous.str, 'end');
  if (!left || scriptOf(left) !== 'devanagari' || scriptOf(right) !== 'devanagari') return '';
  const beforeLeft = previous.str.slice(0, previous.str.length - left.length);
  const followsPunctuation = /[\p{P}\p{S}]\s*$/u.test(beforeLeft);
  if (!followsPunctuation || graphemes(left).length > 2) return '';
  return `${left}${right}`.normalize('NFC');
}

/**
 * Recover a word split *inside* one pdf.js text item.
 *
 * Some ToUnicode maps insert a synthetic space after a Devanagari cluster
 * ending in nukta/virama even though the glyphs form one word (the real
 * fixture extracts क़लम as "क़ लम"). Those marks do not terminate a word, so
 * joining this narrow shape is safe. Ordinary phrases such as "की किताब"
 * remain untouched.
 */
function recoverInternalDevanagariWords(text) {
  const recovered = [];
  const pattern = /([\p{L}\p{M}\p{Cf}]*[\u093C\u094D\u200C\u200D])\s+([\p{L}\p{M}\p{Cf}]+)/gu;
  for (const match of text.matchAll(pattern)) {
    const left = match[1];
    const right = match[2];
    if (scriptOf(left) !== 'devanagari' || scriptOf(right) !== 'devanagari') continue;
    if (graphemes(left).length !== 1) continue;
    recovered.push({
      word: `${left}${right}`.normalize('NFC'),
      offset: match.index,
      end: match.index + match[0].length,
      boundaryRecovered: true,
    });
  }
  return recovered;
}

export function joinTextItems(items) {
  let text = '';
  let previous = null;
  const recovered = [];

  for (const item of items) {
    if (!item || typeof item.str !== 'string' || !Array.isArray(item.transform)) continue;
    const separator = itemBoundary(previous, item);
    const word = recoverBoundaryWord(previous, item, separator);
    if (word) recovered.push({ word, offset: text.length, boundaryRecovered: true });
    if (separator && text && !/\s$/.test(text)) text += separator;
    text += item.str;
    previous = item;
  }
  recovered.push(...recoverInternalDevanagariWords(text));
  return { text, recovered };
}

export async function extractPdf(inputPath) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(inputPath));
  const task = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    cMapUrl: asDirectoryPath(path.join(PDFJS_ROOT, 'cmaps')),
    cMapPacked: true,
    standardFontDataUrl: asDirectoryPath(path.join(PDFJS_ROOT, 'standard_fonts')),
    wasmUrl: asDirectoryPath(path.join(PDFJS_ROOT, 'wasm')),
    iccUrl: asDirectoryPath(path.join(PDFJS_ROOT, 'iccs')),
  });

  try {
    const doc = await task.promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push({ page: pageNumber, ...joinTextItems(content.items) });
      page.cleanup();
    }
    const sample = pages.map(page => page.text).join('\n');
    return {
      pages,
      totalPages: doc.numPages,
      fingerprint: doc.fingerprints?.[0] || '',
      quality: assessTextQuality(sample),
    };
  } finally {
    await task.destroy().catch(() => {});
  }
}

function loadWordFile(file, { required = false } = {}) {
  if (!file) return [];
  if (!fs.existsSync(file)) {
    if (required) throw new Error(`word-exclusion file not found: ${file}`);
    return [];
  }
  const words = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    words.push(...trimmed.split(/\s+/).filter(Boolean));
  }
  return words;
}

export function loadCommonWords(extraFile = '') {
  const builtIn = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'common-words.txt');
  return new Set([
    ...loadWordFile(builtIn),
    ...loadWordFile(extraFile, { required: !!extraFile }),
  ].map(word => canonicalHeadword(word)));
}

/** Small English inflection ladder for comparing against the known-word list. */
export function baseForms(word) {
  const forms = new Set([word]);
  const add = (candidate) => { if (candidate.length >= 3) forms.add(candidate); };
  const suffixes = [
    's', 'es', 'ed', 'ing', 'ly', 'ally', 'er', 'est', 'en',
    'ness', 'ment', 'ments', 'ity', 'ities', 'al', 'ive', 'ous', 'ful', 'less',
    'ion', 'ions', 'tion', 'tions', 'ation', 'ations', 'ition', 'itions',
  ];
  for (const suffix of suffixes) {
    if (!word.endsWith(suffix) || word.length <= suffix.length + 2) continue;
    const stem = word.slice(0, -suffix.length);
    add(stem);
    add(stem + 'e');
    add(stem + 'y');
    if (/([bdfglmnprt])\1$/.test(stem)) add(stem.slice(0, -1));
    if (stem.endsWith('i')) add(stem.slice(0, -1) + 'y');
    if (stem.endsWith('ic')) add(stem.slice(0, -2));
  }
  if (word.endsWith('ies')) add(word.slice(0, -3) + 'y');
  return forms;
}

function isCommon(word, common) {
  const normalized = canonicalHeadword(word);
  const comparisons = new Set([
    normalized,
    normalized.replace(/['’\u2010-\u2015-]/gu, ''),
  ]);
  for (const comparison of comparisons) {
    for (const form of baseForms(comparison)) {
      if (common.has(form)) return true;
    }
  }
  return false;
}

export function isPlausibleWord(word) {
  if (/[\p{N}]/u.test(word)) return false;
  if (/[_@#$%^&*<>{}[\]\\/|=+~`]/u.test(word)) return false;
  if (/\.\p{L}/u.test(word)) return false;
  // Keep authored compounds and contractions intact; connectors are allowed
  // only inside letter/mark runs, never at either edge or doubled.
  if (!/^[\p{L}\p{M}\p{Cf}]+(?:['’\u2010-\u2015-][\p{L}\p{M}\p{Cf}]+)*$/u.test(word)) return false;
  const characters = [...word];
  const scripts = new Set(characters
    .filter(char => /\p{L}/u.test(char))
    .map(char => /\p{Script=Latin}/u.test(char) ? 'latin'
      : /\p{Script=Devanagari}/u.test(char) ? 'devanagari' : 'other'));
  return scripts.size === 1;
}

function cleanContext(text) {
  return text.replace(/\s+/g, ' ').trim();
}

export function contextFor(text, index, wordLength, maxLength = 480) {
  for (const sentence of sentenceSegmenter.segment(text)) {
    const end = sentence.index + sentence.segment.length;
    if (index >= sentence.index && index < end) {
      const cleaned = cleanContext(sentence.segment);
      if (cleaned && cleaned.length <= maxLength) return cleaned;
      break;
    }
  }

  const clusters = [...graphemeSegmenter.segment(text)];
  let center = clusters.findIndex(part => index >= part.index && index < part.index + part.segment.length);
  if (center < 0) center = 0;
  let start = center;
  let end = center;
  let length = Math.max(wordLength, clusters[center]?.segment.length || 0);
  while (length < maxLength && (start > 0 || end < clusters.length - 1)) {
    if (start > 0) length += clusters[--start].segment.length;
    if (length >= maxLength) break;
    if (end < clusters.length - 1) length += clusters[++end].segment.length;
  }
  const from = clusters[start]?.index || 0;
  const toPart = clusters[end];
  const to = toPart ? toPart.index + toPart.segment.length : text.length;
  return `${from > 0 ? '…' : ''}${cleanContext(text.slice(from, to))}${to < text.length ? '…' : ''}`;
}

function minimumLength(word, options) {
  const script = scriptOf(word);
  if (script === 'devanagari') return options.minDevanagariLength;
  if (script === 'latin') return options.minLatinLength;
  return options.minOtherLength;
}

function addOccurrence(seen, rawWord, page, offset, sourceText, options, boundaryRecovered = false) {
  const word = String(rawWord || '').trim().normalize('NFC');
  if (!word) return;
  const key = canonicalHeadword(word);
  let entry = seen.get(key);
  if (!entry) {
    entry = { word, count: 0, page, offset, occurrences: [], boundaryRecovered: false };
    seen.set(key, entry);
  }
  entry.count++;
  entry.boundaryRecovered ||= boundaryRecovered;
  if (entry.occurrences.length < options.maxOccurrences) {
    const text = contextFor(sourceText, offset, word.length);
    if (text && !entry.occurrences.some(item => item.page === page && item.text === text)) {
      entry.occurrences.push({ page, text });
    }
  }
}

export function collectCandidates(pages, rawOptions = {}) {
  const options = { ...DEFAULTS, ...rawOptions };
  const seen = new Map();
  for (const page of pages) {
    const recoveredSpans = (page.recovered || [])
      .filter(item => Number.isInteger(item.offset) && Number.isInteger(item.end));
    for (const part of wordSegmenter.segment(page.text)) {
      if (!part.isWordLike) continue;
      if (recoveredSpans.some(span => part.index >= span.offset &&
        part.index + part.segment.length <= span.end)) continue;
      addOccurrence(seen, part.segment, page.page, part.index, page.text, options);
    }
    // Intl.Segmenter intentionally splits at apostrophes and hyphens. For a
    // book glossary those authored compounds are often exactly the entries a
    // general dictionary misses, so index the complete form as well.
    for (const match of page.text.matchAll(/[\p{L}\p{M}\p{Cf}]+(?:['’\u2010-\u2015-][\p{L}\p{M}\p{Cf}]+)+/gu)) {
      addOccurrence(seen, match[0], page.page, match.index, page.text, options);
    }
    for (const recovered of page.recovered || []) {
      addOccurrence(seen, recovered.word, page.page, recovered.offset, page.text, options, true);
    }
  }

  const common = options.keepCommon ? new Set() : loadCommonWords(options.exclude);
  const eligible = [...seen.values()]
    .filter(entry => entry.count <= options.maxCount)
    .filter(entry => graphemes(entry.word).length >= minimumLength(entry.word, options))
    .filter(entry => isPlausibleWord(entry.word))
    .filter(entry => !isCommon(entry.word, common))
    .filter(entry => !options.dropNames || !/^\p{Lu}/u.test(entry.word));

  // A recurring unfamiliar term is more useful than a one-off oddity. Rank
  // before applying the safety limit, then put the selected set back into
  // reading order so definitions can be authored chapter by chapter.
  const selected = eligible
    .sort((a, b) => b.count - a.count || a.page - b.page || a.offset - b.offset ||
      b.word.length - a.word.length)
    .slice(0, options.limit)
    .sort((a, b) => a.page - b.page || a.offset - b.offset || a.word.localeCompare(b.word));

  return {
    distinctWords: seen.size,
    candidates: selected.map(entry => ({
      word: entry.word,
      definition: '',
      aliases: [],
      count: entry.count,
      page: entry.occurrences[0]?.page || entry.page,
      example: entry.occurrences[0]?.text || '',
      occurrences: entry.occurrences,
      boundaryRecovered: entry.boundaryRecovered || undefined,
    })),
  };
}

function existingEntries(value) {
  if (Array.isArray(value)) return value;
  return value && Array.isArray(value.entries) ? value.entries : null;
}

export function mergeGlossary(existing, generated) {
  const previousEntries = existingEntries(existing);
  if (!previousEntries) throw new Error('Existing output is not a Gloss glossary; refusing to overwrite it');

  const generatedByWord = new Map(generated.entries.map(entry => [canonicalHeadword(entry.word), entry]));
  const entries = [];
  let preservedDefinitions = 0;

  for (const old of previousEntries) {
    if (!old || typeof old !== 'object' || typeof old.word !== 'string' || !old.word.trim()) continue;
    const key = canonicalHeadword(old.word);
    const fresh = generatedByWord.get(key);
    if (fresh) generatedByWord.delete(key);
    if (typeof old.definition === 'string' && old.definition.trim()) preservedDefinitions++;
    entries.push(fresh ? {
      ...fresh,
      ...old,
      // Extraction metadata is refreshed; authored content and unknown custom
      // fields survive. A hand-edited example wins over the generated one.
      count: fresh.count,
      page: old.page || fresh.page,
      example: old.example || fresh.example,
      occurrences: fresh.occurrences,
      boundaryRecovered: fresh.boundaryRecovered,
    } : old);
  }
  entries.push(...generatedByWord.values());

  const oldObject = Array.isArray(existing) ? {} : existing;
  return {
    ...oldObject,
    ...generated,
    name: oldObject.name || generated.name,
    language: oldObject.language || generated.language,
    created: oldObject.created || generated.created,
    entries,
    updated: new Date().toISOString().slice(0, 10),
    merge: {
      preservedDefinitions,
      addedEntries: generatedByWord.size,
      totalEntries: entries.length,
    },
  };
}

function readExisting(outputPath, generated) {
  if (!fs.existsSync(outputPath)) return { glossary: generated, existed: false };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  } catch (err) {
    throw new Error(`Existing glossary is invalid JSON; refusing to overwrite it (${err.message})`);
  }

  const previousFingerprint = typeof parsed?.source === 'object' ? parsed.source.fingerprint : '';
  const nextFingerprint = generated.source.fingerprint;
  if (previousFingerprint && nextFingerprint && previousFingerprint !== nextFingerprint) {
    throw new Error('Existing glossary belongs to a different PDF; choose another output path');
  }
  const previousFile = typeof parsed?.source === 'string' ? parsed.source : parsed?.source?.file;
  const nextFile = generated.source.file;
  if (!previousFingerprint && previousFile && nextFile) {
    const previousPath = path.resolve(path.dirname(outputPath), previousFile);
    const nextPath = path.resolve(path.dirname(outputPath), nextFile);
    if (previousPath !== nextPath) {
      throw new Error('Existing glossary belongs to a different PDF; choose another output path');
    }
  }
  return { glossary: mergeGlossary(parsed, generated), existed: true };
}

export function writeAtomic(outputPath, glossary, { inputPath = '', backup = true } = {}) {
  const output = path.resolve(outputPath);
  const input = inputPath ? fs.realpathSync(inputPath) : '';
  if (input && output === input) throw new Error('Output path is the PDF itself; refusing to overwrite the book');
  if (input && fs.existsSync(output)) {
    const a = fs.statSync(input);
    const b = fs.statSync(output);
    if (a.dev === b.dev && a.ino === b.ino) throw new Error('Output resolves to the PDF itself; refusing to overwrite the book');
  }

  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = path.join(path.dirname(output), `.${path.basename(output)}.${process.pid}.tmp`);
  const backupPath = `${output}.bak`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(glossary, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    if (backup && fs.existsSync(output)) fs.copyFileSync(output, backupPath);
    fs.renameSync(temporary, output);
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* best effort */ }
  }
  return { output, backupPath: backup && fs.existsSync(backupPath) ? backupPath : '' };
}

function validateInteger(name, value, min, max, { allowInfinity = false } = {}) {
  if (allowInfinity && value === Infinity) return;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
}

export function validateOptions(raw = {}) {
  const options = { ...DEFAULTS, ...raw };
  validateInteger('--min-latin-length', options.minLatinLength, 1, 100);
  validateInteger('--min-devanagari-length', options.minDevanagariLength, 1, 100);
  validateInteger('--min-other-length', options.minOtherLength, 1, 100);
  validateInteger('--max-count', options.maxCount, 1, 10_000_000, { allowInfinity: true });
  validateInteger('--limit', options.limit, 1, 200_000);
  validateInteger('maxOccurrences', options.maxOccurrences, 1, 20);
  if (options.language && !/^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/.test(options.language)) {
    throw new Error('--language must be a short BCP-47 tag such as en, hi, ne, or sa');
  }
  return options;
}

export async function buildGlossary(inputPath, rawOptions = {}) {
  const options = validateOptions(rawOptions);
  const input = path.resolve(inputPath);
  if (!fs.existsSync(input) || !fs.statSync(input).isFile()) throw new Error(`PDF not found: ${inputPath}`);
  const output = path.resolve(options.output || path.join(
    path.dirname(input), `${path.basename(input, path.extname(input))}.glossary.json`));

  const extracted = await extractPdf(input);
  if (extracted.quality === 'empty') {
    throw new Error('This PDF has no extractable text (it may be scanned). OCR it before building a glossary.');
  }
  if (extracted.quality === 'garbled' && !options.forceGarbled) {
    throw new Error('This PDF has broken text mappings. Glossary words would be corrupted; use OCR or --force-garbled to inspect anyway.');
  }

  const { distinctWords, candidates } = collectCandidates(extracted.pages, options);
  if (candidates.length === 0) {
    throw new Error('No useful candidates remained. Lower the script-specific minimum length or use --keep-common.');
  }

  const today = new Date().toISOString().slice(0, 10);
  const generated = {
    format: FORMAT,
    version: FORMAT_VERSION,
    name: options.name || `${path.basename(input, path.extname(input))} — glossary`,
    language: options.language,
    scope: 'book',
    source: {
      // Relative to the glossary rather than merely a basename, so scoping
      // still works when -o puts glossaries in a separate directory.
      file: path.relative(path.dirname(output), input) || path.basename(input),
      fingerprint: extracted.fingerprint,
      pages: extracted.totalPages,
    },
    created: today,
    updated: today,
    entries: candidates,
  };

  if (options.listOnly) {
    return { input, output, extracted, distinctWords, candidates, glossary: generated, existed: false };
  }

  const { glossary, existed } = readExisting(output, generated);
  const written = writeAtomic(output, glossary, { inputPath: input, backup: existed });
  return { input, output, extracted, distinctWords, candidates, glossary, existed, ...written };
}
