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

/** Upper bound on the whole ladder (main/dicts.js enforces the same cap). */
export const MAX_CANDIDATES = 32;

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

// ── Base forms ────────────────────────────────────────────────────────────────
//
// Dictionaries list headwords; text is full of inflections. A reader who
// selects "transactions", "stored" or "नेपालको" should get "transaction",
// "store" and "नेपाल" — not "No definition found".
//
// These functions only *propose* base forms. A proposal counts for nothing
// unless a dictionary actually has that headword, and every proposal sits
// below the exact forms in the ladder, so a real entry for the inflected
// word itself always wins.

/**
 * English endings, most conservative first: [ending, replacements…].
 * The order is the point. "uses" must try "use" (drop s) before "us"
 * (drop es); "using" must try "use" before "us".
 */
const ENGLISH_ENDINGS = [
  ['s', ['']],                      // transactions → transaction, uses → use
  ['es', ['']],                     // processes → process, boxes → box
  ['ies', ['y']],                   // policies → policy
  ['ves', ['f', 'fe']],             // halves → half, knives → knife
  ['men', ['man']],                 // policemen → policeman
  ['ied', ['y']],                   // verified → verify
  ['ed', ['e', '']],                // stored → store, accepted → accept
  ['ying', ['ie']],                 // lying → lie
  ['ing', ['e', '']],               // using → use, processing → process
  ['ier', ['y']],                   // easier → easy
  ['iest', ['y']],                  // easiest → easy
  ['er', ['e', '']],                // larger → large, faster → fast
  ['est', ['e', '']],               // largest → large, fastest → fast
  ['ily', ['y']],                   // easily → easy
  ['ally', ['al', '']],             // digitally → digital, basically → basic
  ['ably', ['able']],               // reliably → reliable
  ['ibly', ['ible']],               // possibly → possible
  ['ly', ['']],                     // securely → secure
  ['iness', ['y']],                 // readiness → ready
  ['ness', ['']],                   // awareness → aware
];

/** Endings after which English doubles a final consonant: stopped, running, bigger. */
const DOUBLING_ENDINGS = new Set(['ed', 'ing', 'er', 'est']);
const POSSESSIVE = /(?:['’]s|s['’])$/;

/** Plausible base forms of an English word, best guess first. */
export function englishBaseForms(token) {
  const word = token.toLocaleLowerCase('en');
  const out = [];
  const add = (s) => { if (s.length >= 2 && s !== word && !out.includes(s)) out.push(s); };

  const expand = (w) => {
    for (const [ending, replacements] of ENGLISH_ENDINGS) {
      if (w.length <= ending.length + 1 || !w.endsWith(ending)) continue;
      const stem = w.slice(0, -ending.length);
      for (const replacement of replacements) {
        add(stem + replacement);
        if (replacement === '' && DOUBLING_ENDINGS.has(ending) && /([b-df-hj-np-tv-z])\1$/.test(stem)) {
          add(stem.slice(0, -1));   // stopped → stopp → stop
        }
      }
    }
  };

  // "customers'" and "bank's": drop the possessive, then treat what is left
  // as a word in its own right.
  if (POSSESSIVE.test(word)) {
    const owner = word.replace(/['’]s$/, '').replace(/s['’]$/, 's');
    add(owner);
    expand(owner);
  }
  expand(word);
  return out.slice(0, 14);
}

/**
 * Postpositions and plural markers Nepali writes attached to the word, and
 * the few Hindi does. Longer, compound markers are listed so that
 * "देशहरूको" reaches "देश" in one step.
 */
const DEVANAGARI_SUFFIXES = [
  'को', 'का', 'की', 'के', 'ले', 'मा', 'नै', 'में', 'से', 'ने', 'पर',
  'हरू', 'हरु', 'लाई', 'बाट', 'सँग', 'संग', 'सित', 'तिर', 'देखि', 'सम्म', 'भित्र', 'माथि', 'द्वारा', 'प्रति',
  'पनि', 'पछि', 'अघि', 'भन्दा', 'जस्तो', 'जस्तै', 'सहित', 'समेत', 'बिना', 'विना', 'अनुसार', 'सम्बन्धी',
  'हरूको', 'हरूका', 'हरूकी', 'हरूले', 'हरूमा', 'हरुको', 'हरुले', 'हरुमा',
  'हरूलाई', 'हरूबाट', 'हरूसँग', 'हरुलाई', 'हरुबाट',
];

/** Hindi plural and oblique endings: [ending, replacement]. */
const HINDI_ENDINGS = [
  ['ियों', 'ी'], ['ियाँ', 'ी'], ['ियां', 'ी'],   // लड़कियों, लड़कियाँ → लड़की
  ['ओं', ''],                                     // महिलाओं → महिला
  ['ों', ''], ['ों', 'ा'],                         // घरों → घर, लड़कों → लड़का
  ['ें', ''], ['एँ', ''], ['एं', ''],               // किताबें → किताब, मालाएँ → माला
  ['े', 'ा'],                                     // लड़के → लड़का
];

/**
 * Nepali verb forms back to the dictionary form, which ends in -नु:
 * [ending, replacement]. Participles and converbs make up a large share of
 * running Nepali text (गरिएको, राख्ने, बसेर, हुँदा), and none of them is a
 * headword. More specific endings come first.
 */
const NEPALI_VERB_ENDINGS = [
  ['नुपर्ने', 'नु'], ['नुपर्छ', 'नु'], ['नुहोस्', 'नु'],        // गर्नुपर्ने → गर्नु
  ['िएको', '्नु'], ['िएका', '्नु'], ['िएकी', '्नु'],             // गरिएको → गर्नु
  ['इएको', 'उनु'], ['इएका', 'उनु'], ['इएको', 'नु'],             // बनाइएको → बनाउनु, लिइएको → लिनु
  ['ाएको', 'ाउनु'], ['ाएका', 'ाउनु'], ['ाएर', 'ाउनु'],           // हराएको → हराउनु, मिलाएर → मिलाउनु
  ['ाउने', 'ाउनु'], ['ाउन', 'ाउनु'], ['ाउँदा', 'ाउनु'], ['ाउँछ', 'ाउनु'],
  ['एको', 'नु'], ['एका', 'नु'], ['एर', 'नु'], ['एपछि', 'नु'],    // खाएर → खानु, लिएर → लिनु
  ['ेको', '्नु'], ['ेका', '्नु'], ['ेकी', '्नु'],                // बलेको → बल्नु
  ['ेर', '्नु'], ['ेपछि', '्नु'],                               // बसेर → बस्नु
  ['्दाको', '्नु'], ['्दा', '्नु'], ['्दै', '्नु'], ['्दछ', '्नु'],   // झर्दा → झर्नु
  ['्छन्', '्नु'], ['्छ', '्नु'], ['्थ्यो', '्नु'], ['्यो', '्नु'],   // गर्छ → गर्नु
  ['ँदाको', 'नु'], ['ँदा', 'नु'], ['ँदै', 'नु'],                 // हुँदा → हुनु
  ['न्छन्', 'नु'], ['न्छ', 'नु'],                               // हुन्छ → हुनु
  ['िने', '्नु'],                                               // गरिने → गर्नु
  ['ने', 'नु'],                                                 // राख्ने → राख्नु
  ['न', 'नु'],                                                  // राख्न → राख्नु
];

const VIRAMA = '\u094D';

/** Plausible uninflected forms of a Devanagari word, most conservative first. */
export function devanagariStems(word) {
  const out = [];
  const add = (s) => {
    // A stem must be a whole word: at least two letters, not cut mid-conjunct.
    if ([...s].length >= 2 && !s.endsWith(VIRAMA) && s !== word && !out.includes(s)) out.push(s);
  };
  for (const suffix of DEVANAGARI_SUFFIXES) {
    if (word.length <= suffix.length || !word.endsWith(suffix)) continue;
    const stem = word.slice(0, -suffix.length);
    add(stem);
    // Nepali nouns and adjectives in -ो take -ा before a postposition:
    // टाउकाको is टाउको + को.
    if (stem.endsWith('ा')) add(`${stem.slice(0, -1)}ो`);
  }

  const verbForms = (form) => {
    for (const [ending, replacement] of NEPALI_VERB_ENDINGS) {
      if (form.length > ending.length && form.endsWith(ending)) add(form.slice(0, -ending.length) + replacement);
    }
  };
  verbForms(word);
  // The negative is a prefix: नगर्ने is न + गर्ने.
  if (word.startsWith('न') && [...word].length > 3) verbForms(word.slice(1));

  for (const [ending, replacement] of HINDI_ENDINGS) {
    if (word.length > ending.length && word.endsWith(ending)) add(word.slice(0, -ending.length) + replacement);
  }
  // Plural and oblique of a Nepali word in -ो: मसिना → मसिनो.
  if (word.endsWith('ा')) add(`${word.slice(0, -1)}ो`);
  return out.slice(0, 14);
}

/**
 * Deterministic lookup-candidate ladder.
 * Order: exact → NFC → edge-trimmed → script-appropriate variants →
 * Latin case variants → base forms of an inflected word. Deduplicated,
 * empty and oversize entries dropped.
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

  // Base forms, for single words only — a phrase is looked up as written.
  if (!/\s/.test(trimmed)) {
    if (isLatinToken(trimmed)) {
      if (trimmed.includes('-')) {
        // "real-time", "state-owned": dictionaries spell compounds every way.
        const parts = trimmed.split('-').filter(Boolean);
        push(parts.join(' '));
        push(parts.join(''));
        push(parts.join(' ').toLocaleLowerCase('en'));
        push(parts.join('').toLocaleLowerCase('en'));
      }
      if (POSSESSIVE.test(trimmed)) push(trimmed.replace(/['’]s$/, '').replace(/s['’]$/, 's'));
      for (const base of englishBaseForms(trimmed)) push(base);
      if (trimmed.includes('-')) {
        // Last resort for a compound nobody lists: its head word, then the rest.
        const parts = trimmed.toLocaleLowerCase('en').split('-').filter(part => part.length >= 3);
        for (const part of [...parts].reverse()) {
          push(part);
          for (const base of englishBaseForms(part).slice(0, 2)) push(base);
        }
      }
    } else if (hasDevanagari(trimmed)) {
      for (const stem of devanagariStems(trimmed)) push(stem);
    }
  }

  return out.slice(0, MAX_CANDIDATES);
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
