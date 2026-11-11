'use strict';
/**
 * JSON glossary backend.
 *
 * Glossaries generated for one PDF are book-scoped. General-purpose JSON
 * dictionaries can opt into `"scope": "global"` (or omit `source`). The
 * parser remains backward-compatible with the first draft format: a string
 * `source`, one `example`, and one `page` still work.
 */

const fs = require('fs');
const path = require('path');

const FORMAT = 'gloss-glossary';
const FORMAT_VERSION = 1;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 200_000;
const MAX_WORD_LENGTH = 200;
const MAX_DEFINITION_LENGTH = 64 * 1024;
const MAX_EXAMPLE_LENGTH = 2000;
const MAX_OCCURRENCES = 8;
const MAX_ALIASES = 48;

function clippedString(value, max, { trim = true } = {}) {
  if (typeof value !== 'string') return '';
  const text = trim ? value.trim() : value;
  return text.slice(0, max);
}

function positivePage(value) {
  return Number.isInteger(value) && value > 0 && value <= 10_000_000 ? value : null;
}

function normalizeOccurrence(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = clippedString(raw.text ?? raw.example, MAX_EXAMPLE_LENGTH);
  if (!text) return null;
  return { text, page: positivePage(raw.page) };
}

function parseSource(parsed, glossaryPath) {
  const explicitScope = parsed && typeof parsed === 'object' ? parsed.scope : null;
  const raw = parsed && typeof parsed === 'object' ? parsed.source : null;
  if (explicitScope != null && explicitScope !== 'global' && explicitScope !== 'book') {
    throw new Error('Glossary "scope" must be "book" or "global"');
  }
  const scope = explicitScope || (raw ? 'book' : 'global');
  if (scope === 'global') {
    return { scope, file: '', resolvedPath: '', fingerprint: '' };
  }

  const file = clippedString(typeof raw === 'string' ? raw : raw?.file, 4096);
  const fingerprint = clippedString(typeof raw === 'object' ? raw?.fingerprint : '', 200)
    .toLocaleLowerCase();
  if (!file && !fingerprint) {
    throw new Error('A book-scoped glossary needs source.file or source.fingerprint');
  }
  return {
    scope,
    file,
    resolvedPath: file ? path.resolve(path.dirname(glossaryPath), file) : '',
    fingerprint,
  };
}

function sameFilePath(a, b) {
  if (!a || !b) return false;
  let left = path.resolve(a);
  let right = path.resolve(b);
  try { left = fs.realpathSync(left); } catch { /* a moved pair may not exist yet */ }
  try { right = fs.realpathSync(right); } catch { /* compare normalized paths */ }
  return left === right;
}

class Glossary {
  constructor(filePath) {
    const realPath = fs.realpathSync(filePath);
    const stat = fs.statSync(realPath);
    if (!stat.isFile()) throw new Error('Glossary path is not a regular file');
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`Glossary is larger than ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB`);
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(realPath, 'utf8'));
    } catch (err) {
      throw new Error(`Not valid JSON (${String(err.message).slice(0, 80)})`);
    }

    const entries = Array.isArray(parsed) ? parsed : parsed && parsed.entries;
    if (!Array.isArray(entries)) throw new Error('Expected an "entries" array');
    if (!Array.isArray(parsed) && parsed.format && parsed.format !== FORMAT) {
      throw new Error(`Unsupported glossary format: ${String(parsed.format).slice(0, 80)}`);
    }
    if (!Array.isArray(parsed) && parsed.version != null && parsed.version !== FORMAT_VERSION) {
      throw new Error(`Unsupported glossary version: ${String(parsed.version).slice(0, 20)}`);
    }

    this.filePath = realPath;
    this.modifiedAt = stat.mtimeMs;
    this.title = clippedString(Array.isArray(parsed) ? '' : parsed.name, 200);
    this.language = clippedString(Array.isArray(parsed) ? '' : parsed.language, 35);
    if (this.language && !/^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/.test(this.language)) {
      this.language = '';
    }

    const source = parseSource(parsed, realPath);
    this.scope = source.scope;
    this.sourceFile = source.file;
    this.sourcePath = source.resolvedPath;
    this.sourceFingerprint = source.fingerprint;

    // Headwords and aliases share one index. Both the authored text and NFC
    // form are registered because Devanagari nukta spellings may arrive in
    // either representation.
    this.index = new Map();
    let usable = 0;
    let valid = 0;
    // Aliases are indexed after every headword, so an alias can never take
    // the place of a real entry: "saw" listed as a form of "see" must not
    // hide the entry for the tool.
    const aliasKeys = [];

    for (const raw of entries.slice(0, MAX_ENTRIES)) {
      if (!raw || typeof raw !== 'object') continue;
      const rawWord = typeof raw.word === 'string' ? raw.word.trim() : '';
      if (!rawWord || rawWord.length > MAX_WORD_LENGTH) continue;
      const word = rawWord;
      valid++;

      const definition = clippedString(raw.definition, MAX_DEFINITION_LENGTH);
      if (!definition) continue; // a draft entry; becomes live after reload

      const occurrences = [];
      if (Array.isArray(raw.occurrences)) {
        for (const occurrence of raw.occurrences.slice(0, MAX_OCCURRENCES)) {
          const normalized = normalizeOccurrence(occurrence);
          if (normalized) occurrences.push(normalized);
        }
      }
      if (occurrences.length === 0) {
        const legacy = normalizeOccurrence({ text: raw.example, page: raw.page });
        if (legacy) occurrences.push(legacy);
      }

      const entry = {
        keyText: word,
        definition,
        example: occurrences[0]?.text || '',
        page: occurrences[0]?.page || positivePage(raw.page),
        occurrences,
        count: Number.isInteger(raw.count) && raw.count > 0 ? raw.count : null,
      };

      if (!this.index.has(word)) this.index.set(word, entry);
      const nfcWord = word.normalize('NFC');
      if (!this.index.has(nfcWord)) this.index.set(nfcWord, entry);
      if (Array.isArray(raw.aliases)) {
        for (const alias of raw.aliases.slice(0, MAX_ALIASES)) {
          const text = typeof alias === 'string' ? alias.trim() : '';
          if (text && text.length <= MAX_WORD_LENGTH) aliasKeys.push([text, entry]);
        }
      }
      usable++;
    }
    for (const [key, entry] of aliasKeys) {
      if (!this.index.has(key)) this.index.set(key, entry);
      const nfc = key.normalize('NFC');
      if (!this.index.has(nfc)) this.index.set(nfc, entry);
    }

    if (valid === 0) throw new Error('No valid glossary headwords');
    this.size = usable;
    this.totalEntries = valid;
  }

  matchesDocument(document) {
    if (this.scope === 'global') return true;
    if (!document) return false;
    const doc = typeof document === 'string' ? { path: document } : document;
    const fingerprint = clippedString(doc.fingerprint, 200).toLocaleLowerCase();
    if (this.sourceFingerprint && fingerprint && this.sourceFingerprint === fingerprint) return true;
    return sameFilePath(this.sourcePath, doc.path);
  }

  lookup(word) {
    const hit = this.index.get(word);
    return hit ? {
      keyText: hit.keyText,
      definition: hit.definition,
      example: hit.example,
      page: hit.page,
      occurrences: hit.occurrences,
      count: hit.count,
      language: this.language,
    } : { keyText: word, definition: null };
  }

  close() {
    this.index.clear();
  }
}

function isGlossaryPath(filePath) {
  return /\.json$/i.test(filePath);
}

module.exports = { FORMAT, FORMAT_VERSION, Glossary, isGlossaryPath };
