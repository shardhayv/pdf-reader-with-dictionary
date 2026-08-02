/**
 * text.js — pure Unicode text utilities for Gloss.
 * No DOM, no Electron, no dependencies: unit-testable in plain Node.
 *
 * Design constraints (see docs/ARCHITECTURE.md):
 *  - Never split inside a grapheme cluster (conjuncts, matras, nukta,
 *    anusvara/chandrabindu, ZWJ/ZWNJ sequences must survive intact).
 *  - Never apply Latin casing rules to non-Latin scripts.
 *  - NFC note: Devanagari precomposed nukta forms U+0958–U+095F are
 *    composition exclusions — NFC *decomposes* them, so exact and NFC
 *    forms are distinct lookup candidates.
 */

const ZERO_WIDTH_JOINERS = /[‌‍]/g; // ZWNJ, ZWJ

// Edge trim: punctuation, symbols, separators, whitespace and format
// controls (ZWJ/ZWNJ at the edges are meaningless). Includes danda ।/॥.
// Interior characters are never touched.
const EDGE_TRIM = /^[\p{P}\p{S}\p{Z}\p{Cf}\s]+|[\p{P}\p{S}\p{Z}\p{Cf}\s]+$/gu;

const LATIN_ONLY = /^[\p{Script=Latin}\p{M}\p{Nd}'’.\-]+$/u;

const MAX_CANDIDATE_LENGTH = 120;

let graphemeSegmenter = null;
const wordSegmenters = new Map();

function getGraphemeSegmenter() {
  if (!graphemeSegmenter) {
    graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  }
  return graphemeSegmenter;
}

function getWordSegmenter(locale) {
  const key = locale || 'und';
  if (!wordSegmenters.has(key)) {
    wordSegmenters.set(key, new Intl.Segmenter(locale, { granularity: 'word' }));
  }
  return wordSegmenters.get(key);
}

/** Split into grapheme clusters (always safe for Devanagari sequences). */
export function graphemes(text) {
  return [...getGraphemeSegmenter().segment(text)].map(s => s.segment);
}

/** Word segments: [{ segment, index, isWordLike }]. */
export function segmentWords(text, locale) {
  return [...getWordSegmenter(locale).segment(text)]
    .map(({ segment, index, isWordLike }) => ({ segment, index, isWordLike: !!isWordLike }));
}

/** Count word-like segments (used to gate phrase auto-lookup). */
export function countWords(text, locale) {
  return segmentWords(text, locale).filter(s => s.isWordLike).length;
}

/** Trim punctuation/symbols/whitespace/format controls from both edges only. */
export function trimEdges(text) {
  return text.replace(EDGE_TRIM, '');
}

/** Collapse interior whitespace runs to single spaces (phrase candidates). */
export function collapseWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

export function stripJoiners(text) {
  return text.replace(ZERO_WIDTH_JOINERS, '');
}

/** True if the text contains at least one Devanagari code point. */
export function hasDevanagari(text) {
  return /\p{Script=Devanagari}/u.test(text);
}

/** True if the token is Latin-script (letters/marks/digits/apostrophes/hyphen). */
export function isLatinToken(text) {
  return text.length > 0 && LATIN_ONLY.test(text) && /\p{Script=Latin}/u.test(text);
}

/**
 * Deterministic lookup-candidate ladder.
 * Order: exact → NFC → edge-trimmed → script-appropriate variants →
 * Latin case variants. Deduplicated, empty and oversize entries dropped.
 * The original selection is never mutated by callers — candidates are
 * for lookup only; copying must always reproduce the source text.
 */
export function lookupCandidates(rawSelection) {
  const out = [];
  const push = (s) => {
    if (s && s.length <= MAX_CANDIDATE_LENGTH && !out.includes(s)) out.push(s);
  };

  const exact = collapseWhitespace(rawSelection);
  push(exact);

  const nfc = exact.normalize('NFC');
  push(nfc);

  const trimmed = trimEdges(nfc);
  push(trimmed);
  push(trimEdges(exact));

  if (!trimmed) return out;

  // Script-appropriate variants.
  if (/[‌‍]/.test(trimmed)) {
    push(stripJoiners(trimmed));
  }

  // Latin-only case alternatives — never applied to Devanagari.
  if (isLatinToken(trimmed)) {
    const lower = trimmed.toLocaleLowerCase('en');
    push(lower);
    if (lower.length > 0) {
      const first = graphemes(lower)[0];
      push(first.toLocaleUpperCase('en') + lower.slice(first.length));
    }
    push(trimmed.toLocaleUpperCase('en'));
  }

  return out;
}

/**
 * Whether a selection should auto-trigger a lookup.
 * Single words and short deliberate phrases yes; long copy-selections no.
 */
export const AUTO_LOOKUP_MAX_CHARS = 80;
export const AUTO_LOOKUP_MAX_WORDS = 6;

export function isAutoLookupCandidate(text) {
  const t = collapseWhitespace(text);
  if (!t || t.length > AUTO_LOOKUP_MAX_CHARS) return false;
  if (!/[\p{L}\p{N}]/u.test(t)) return false; // needs at least one letter/digit
  return countWords(t) <= AUTO_LOOKUP_MAX_WORDS;
}

/**
 * Search index: a case-folded, NFC-normalized haystack plus, for every
 * normalized character position, the original start and end offsets of the
 * grapheme cluster it belongs to.
 *
 * Normalization is applied per cluster, so offsets survive length changes
 * (İ → i̇, precomposed क़ → क + nukta). Recording both ends of the cluster —
 * rather than only its start — is what lets a match that begins or ends
 * inside a cluster expand to that whole cluster instead of collapsing to an
 * empty range.
 */
export function buildSearchIndex(text) {
  let norm = '';
  const starts = [];
  const ends = [];
  for (const { segment, index } of getGraphemeSegmenter().segment(text)) {
    const n = segment.normalize('NFC').toLocaleLowerCase();
    const clusterEnd = index + segment.length;
    for (let i = 0; i < n.length; i++) {
      starts.push(index);
      ends.push(clusterEnd);
    }
    norm += n;
  }
  return { norm, starts, ends };
}

/** Normalize a search query the same way the index normalizes text. */
export function normalizeQuery(query) {
  let out = '';
  for (const { segment } of getGraphemeSegmenter().segment(query)) {
    out += segment.normalize('NFC').toLocaleLowerCase();
  }
  return out;
}

/**
 * All matches of `query` in an indexed page.
 * Returns original-string ranges: [{ start, end }].
 */
export function findMatches(index, query) {
  const needle = normalizeQuery(query);
  if (!needle) return [];
  const { norm, starts, ends } = index;
  const matches = [];
  let from = 0;
  for (;;) {
    const at = norm.indexOf(needle, from);
    if (at === -1) break;
    // Expand the hit to whole grapheme clusters. Searching a prefix such as
    // "नेप" lands inside the cluster "पा"; reporting the raw offsets would
    // give an empty range that highlights nothing, so the match grows to the
    // cluster it touches. A match can therefore never be empty, and never
    // cuts a conjunct in half.
    const start = starts[at];
    const end = ends[at + needle.length - 1];
    if (end > start && (matches.length === 0 || start >= matches[matches.length - 1].end)) {
      matches.push({ start, end });
    }
    from = at + needle.length;
  }
  return matches;
}

/**
 * Classify extracted PDF text quality.
 *  - 'empty'   : no meaningful text (likely scanned images)
 *  - 'garbled' : dominated by replacement chars / private-use glyph soup
 *                (broken or missing ToUnicode maps)
 *  - 'ok'      : usable text
 */
export const GARBLED_RATIO_THRESHOLD = 0.05;

export function assessTextQuality(sampleText) {
  const letters = (sampleText.match(/[\p{L}\p{N}]/gu) || []).length;
  if (letters < 8) return 'empty';
  const bad = (sampleText.match(/[\uFFFD\uE000-\uF8FF\u0000-\u0008\u000B\u000E-\u001F]/gu) || []).length;
  // Measured separation on real documents: a Chromium-produced PDF whose
  // Devanagari conjuncts reverse-map to NUL scores ~0.17, while well-formed
  // Latin and Devanagari documents both score 0.00.
  return bad / (letters + bad) > GARBLED_RATIO_THRESHOLD ? 'garbled' : 'ok';
}
