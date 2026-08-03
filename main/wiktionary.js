'use strict';
/**
 * Wiktionary definition lookup (main process — the renderer has no network).
 *
 * This is the online *dictionary* tier, as opposed to wiki.js, which is the
 * online *encyclopedia* tier. Wikipedia answers "what is this thing"; for a
 * word met while reading, the wanted answer is almost always "what does this
 * word mean", and only Wiktionary gives that: part of speech, senses, and
 * usage, in the same shape a printed dictionary would.
 *
 * Only the English edition is contacted, for two reasons:
 *   1. `/page/definition/` is implemented by en.wiktionary alone; the hi, ne
 *      and mai editions answer 501 for it.
 *   2. en.wiktionary defines non-English headwords *in English* and returns
 *      them grouped by language code, so a Devanagari selection comes back as
 *      Hindi/Nepali/Sanskrit/Marathi sections glossed in English — which is
 *      what a reader of a Devanagari text actually wants.
 *
 * Definition bodies are Parsoid HTML. They are normalized here (internal wiki
 * links become entry:// cross-references the popup can follow, presentational
 * cruft is dropped) but they are NOT trusted: the renderer runs every
 * definition through DOMPurify exactly as it does for MDX dictionaries.
 */

const { app, net } = require('electron');

const HOST = 'en.wiktionary.org';
const TIMEOUT_MS = 6000;
const MAX_WORD_LENGTH = 128;

// "run" alone has 72 verb senses; a popup is not the place for all of them.
const MAX_SECTIONS = 6;
const MAX_SENSES = 8;
const MAX_EXAMPLES = 2;
const MAX_DEFINITION_LENGTH = 1500;

/** Language codes the app already knows about, preferred in this order. */
const PREFERRED_ORDER = ['en', 'hi', 'ne', 'mai', 'sa', 'mr'];

/**
 * Rewrite one href from Parsoid output into something the popup can use.
 * Anything not understood returns '' and the link is flattened to plain text.
 */
function rewriteHref(raw) {
  const href = String(raw).trim();
  if (!href) return '';
  // Protocol-relative interwiki links (//en.wikipedia.org/wiki/…).
  if (href.startsWith('//')) return `https:${href}`;
  if (/^https?:\/\//i.test(href)) return href;

  // Internal wiki links: /wiki/Foo, ./Foo, or Foo#English.
  let page = '';
  if (href.startsWith('/wiki/')) page = href.slice('/wiki/'.length);
  else if (href.startsWith('./')) page = href.slice(2);
  else if (!href.includes(':') && !href.startsWith('#')) page = href;
  if (!page) return '';

  page = page.split('#')[0];
  try {
    page = decodeURIComponent(page);
  } catch { /* leave it encoded rather than dropping a usable link */ }
  page = page.replace(/_/g, ' ').trim();
  // Appendix:, Wiktionary:, Reconstruction: … are not lookupable headwords.
  if (!page || /^[A-Za-z]+:/.test(page)) return '';
  return `entry://${encodeURIComponent(page)}`;
}

/**
 * Normalize a Parsoid definition fragment. DOMPurify in the renderer remains
 * the security boundary; this only makes the fragment useful and compact.
 */
function normalizeHtml(html) {
  return String(html)
    // Parsoid emits per-template <style> blocks that carry no meaning here.
    .replace(/<style\b[^>]*>[\s\S]*?(?:<\/style\s*>|$)/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    // Bookkeeping attributes (about="#mwt6", typeof="mw:Transclusion", rel=…)
    // that only exist to tie the fragment back to the wiki's parser state.
    // class goes too: the renderer's sanitizer drops it regardless, and
    // removing it here lets the empty-span cleanup below actually fire.
    .replace(/\s(?:about|typeof|rel|class|id|data-mw|data-mw-deduplicate)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi, '')
    .replace(/\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi, (_m, d, s, u) => {
      const rewritten = rewriteHref(d ?? s ?? u ?? '');
      return rewritten ? ` href="${rewritten.replace(/"/g, '&quot;')}"` : '';
    })
    // Empty spans left behind by transclusion placeholders.
    .replace(/<span\s*>\s*<\/span>/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizeSense(sense) {
  const definition = normalizeHtml(sense?.definition || '').slice(0, MAX_DEFINITION_LENGTH);
  if (!definition) return null;
  const examples = Array.isArray(sense?.examples)
    ? sense.examples
      .map(ex => normalizeHtml(ex).slice(0, MAX_DEFINITION_LENGTH))
      .filter(Boolean)
      .slice(0, MAX_EXAMPLES)
    : [];
  return { definition, examples };
}

/**
 * The API returns { <langCode>: [ {partOfSpeech, language, definitions} ] }.
 * Sections for the reader's preferred language come first, then English, then
 * whatever else the page defines.
 */
function buildSections(json, preferredLang) {
  const order = [preferredLang, ...PREFERRED_ORDER];
  const codes = Object.keys(json).sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
  });

  const sections = [];
  for (const code of codes) {
    const group = Array.isArray(json[code]) ? json[code] : [];
    for (const entry of group) {
      if (sections.length >= MAX_SECTIONS) return sections;
      const senses = (Array.isArray(entry?.definitions) ? entry.definitions : [])
        .map(normalizeSense)
        .filter(Boolean)
        .slice(0, MAX_SENSES);
      if (senses.length === 0) continue;
      sections.push({
        lang: code === 'other' ? '' : code,
        language: typeof entry?.language === 'string' ? entry.language.slice(0, 60) : '',
        partOfSpeech: typeof entry?.partOfSpeech === 'string' ? entry.partOfSpeech.slice(0, 40) : '',
        senses,
      });
    }
  }
  return sections;
}

/**
 * @returns {Promise<
 *   {status:'hit', word:string, sections:Array, url:string} |
 *   {status:'miss'} | {status:'offline'} | {status:'error'}>}
 */
async function lookup(preferredLang, word) {
  const query = typeof word === 'string' ? word.trim().slice(0, MAX_WORD_LENGTH) : '';
  if (!query) return { status: 'miss' };

  const url = `https://${HOST}/api/rest_v1/page/definition/${encodeURIComponent(query)}?redirect=true`;
  let res;
  try {
    res = await net.fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'User-Agent': `Gloss-PDF-Reader/${app.getVersion()} (desktop; offline-first dictionary fallback)`,
        Accept: 'application/json',
      },
    });
  } catch {
    return { status: net.isOnline() ? 'error' : 'offline' };
  }

  try {
    if (res.status === 404) return { status: 'miss' };
    if (!res.ok) return { status: 'error' };
    const json = await res.json();
    if (!json || typeof json !== 'object' || Array.isArray(json)) return { status: 'miss' };
    const sections = buildSections(json, typeof preferredLang === 'string' ? preferredLang : 'en');
    if (sections.length === 0) return { status: 'miss' };
    return {
      status: 'hit',
      word: query,
      sections,
      url: `https://${HOST}/wiki/${encodeURIComponent(query)}`,
    };
  } catch {
    return { status: 'error' };
  }
}

module.exports = { lookup, normalizeHtml, rewriteHref, buildSections };
