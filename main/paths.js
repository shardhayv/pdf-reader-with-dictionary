'use strict';
/**
 * Path safety for user-opened PDFs.
 *
 * Trust model: the renderer can never name an arbitrary file. Every path
 * that reaches readPdfSafely() originates from a user action the main
 * process (or the isolated preload, for drag-and-drop) observed: file
 * dialog, CLI argument, second-instance argv, recent-files click, or a
 * dropped File resolved via webUtils. Paths are canonicalized with
 * realpath before use and reads go through a validated file handle so a
 * symlink swapped in after approval cannot redirect the read.
 */

const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

const MAX_PDF_BYTES = 512 * 1024 * 1024; // friendly cap; stat-checked before allocation
const MAGIC_WINDOW = 1024; // %PDF- header must appear in the first 1 KiB per spec

/** Realpaths of documents the user has opened this session. */
const approvedRealPaths = new Set();

function approve(realPath) {
  approvedRealPaths.add(realPath);
}

function isApproved(realPath) {
  return approvedRealPaths.has(realPath);
}

function looksLikePdfName(p) {
  return typeof p === 'string' && /\.pdf$/i.test(p);
}

/**
 * Turn one argv token into an absolute filesystem path, or null.
 *
 * Desktop entries launch with the %U field code, so a file manager hands us
 * a file:// URL rather than a plain path — and a URL-encoded one whenever
 * the name contains spaces or non-ASCII characters. Any other scheme is
 * rejected outright: nothing remote is ever opened this way.
 */
function toLocalPath(raw, cwd) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.startsWith('-')) return null;

  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    if (!/^file:/i.test(raw)) return null;
    try {
      return fileURLToPath(raw);
    } catch {
      return null;
    }
  }
  return path.resolve(cwd || process.cwd(), raw);
}

/**
 * Extract candidate PDF paths from a process argv.
 * Skips the binary, flags, non-file URLs, and anything that is not an
 * existing regular file with a .pdf name. Relative paths resolve against
 * `cwd` (important for second-instance events, whose cwd differs from ours).
 */
function extractPdfArgs(argv, cwd) {
  const out = [];
  for (const raw of (argv || []).slice(1)) {
    const abs = toLocalPath(raw, cwd);
    if (!abs || !looksLikePdfName(abs)) continue;
    try {
      if (fs.statSync(abs).isFile()) out.push(abs);
    } catch {
      /* nonexistent — ignore */
    }
  }
  return out;
}

/**
 * Canonicalize, validate, and read a PDF. Returns a discriminated result;
 * never throws. On success the realpath is registered as approved.
 * @returns {Promise<{ok:true, realPath:string, name:string, size:number,
 *   mtimeMs:number, data:Buffer} | {ok:false, code:string, message:string}>}
 */
async function readPdfSafely(requestedPath) {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0 || requestedPath.length > 4096) {
    return fail('bad_request', 'Invalid file path.');
  }

  let realPath;
  try {
    realPath = await fs.promises.realpath(requestedPath);
  } catch (err) {
    return err.code === 'EACCES'
      ? fail('permission', 'Permission denied reading this file.')
      : fail('not_found', 'The file could not be found. It may have been moved or deleted.');
  }

  let fh = null;
  try {
    fh = await fs.promises.open(realPath, 'r');
    const stat = await fh.stat();

    if (!stat.isFile()) return fail('not_file', 'That path is not a regular file.');
    if (stat.size === 0) return fail('empty', 'The file is empty.');
    if (stat.size > MAX_PDF_BYTES) {
      return fail('too_large', `The file is larger than ${Math.round(MAX_PDF_BYTES / 1024 / 1024)} MB.`);
    }

    const head = Buffer.alloc(Math.min(MAGIC_WINDOW, stat.size));
    await fh.read(head, 0, head.length, 0);
    if (!head.includes('%PDF-')) {
      return fail('not_pdf', 'This file does not look like a PDF document.');
    }

    // readFile loops internally; a single read() is not guaranteed to fill
    // the buffer, which would spuriously reject large documents.
    const data = await fh.readFile();
    if (data.length !== stat.size) return fail('unreadable', 'The file could not be read completely.');

    approve(realPath);
    return {
      ok: true,
      realPath,
      name: path.basename(realPath),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      data,
    };
  } catch (err) {
    return err.code === 'EACCES'
      ? fail('permission', 'Permission denied reading this file.')
      : fail('unreadable', 'The file could not be read.');
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

function fail(code, message) {
  return { ok: false, code, message };
}

module.exports = {
  MAX_PDF_BYTES,
  approve,
  isApproved,
  looksLikePdfName,
  extractPdfArgs,
  readPdfSafely,
};
