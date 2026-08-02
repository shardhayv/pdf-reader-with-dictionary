'use strict';
/**
 * Wikipedia summary lookup (main process — the renderer has no network).
 * Language is user-configurable; only allowlisted language editions are
 * ever contacted. Results are plain text (title/extract), so the renderer
 * escapes rather than sanitizes them.
 */

const { net } = require('electron');

const WIKI_LANGS = new Set(['en', 'hi', 'ne', 'mai']);
const TIMEOUT_MS = 6000;
const MAX_TITLE_LENGTH = 256;

/**
 * @returns {Promise<
 *   {status:'hit', title:string, extract:string, url:string, lang:string} |
 *   {status:'miss'} | {status:'offline'} | {status:'error'}>}
 */
async function lookup(lang, title) {
  const language = WIKI_LANGS.has(lang) ? lang : 'en';
  const query = typeof title === 'string' ? title.trim().slice(0, MAX_TITLE_LENGTH) : '';
  if (!query) return { status: 'miss' };

  const url = `https://${language}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}?redirect=true`;
  let res;
  try {
    res = await net.fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'User-Agent': 'Gloss-PDF-Reader/2.0 (desktop; offline-first dictionary fallback)',
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
    if (!json || json.type === 'disambiguation') return { status: 'miss' };
    const extract = typeof json.extract === 'string' ? json.extract.trim() : '';
    if (!extract) return { status: 'miss' };
    const pageUrl = json.content_urls && json.content_urls.desktop && typeof json.content_urls.desktop.page === 'string'
      ? json.content_urls.desktop.page
      : `https://${language}.wikipedia.org/wiki/${encodeURIComponent(query)}`;
    return {
      status: 'hit',
      title: typeof json.title === 'string' ? json.title.slice(0, 300) : query,
      extract: extract.slice(0, 4000),
      url: pageUrl,
      lang: language,
    };
  } catch {
    return { status: 'error' };
  }
}

module.exports = { lookup, WIKI_LANGS };
