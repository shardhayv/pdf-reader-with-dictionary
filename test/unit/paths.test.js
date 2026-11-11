/**
 * Path validation and argv parsing — the boundary that decides which files
 * the app will ever read.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const paths = require('../../main/paths.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-paths-'));
}

const MINIMAL_PDF =
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n';

// ── argv extraction ───────────────────────────────────────────────────────────

test('extractPdfArgs ignores flags and non-PDF arguments', () => {
  const dir = tmpdir();
  const pdf = path.join(dir, 'doc.pdf');
  fs.writeFileSync(pdf, MINIMAL_PDF);

  const argv = [
    '/usr/bin/gloss',
    '--no-sandbox',
    '--enable-features=SomeFeature',
    '-v',
    'notes.txt',
    pdf,
  ];
  assert.deepEqual(paths.extractPdfArgs(argv, dir), [pdf]);
});

test('extractPdfArgs resolves relative paths against the given cwd', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'rel.pdf'), MINIMAL_PDF);
  // A second instance reports its own cwd; resolving against ours would be wrong.
  assert.deepEqual(paths.extractPdfArgs(['gloss', 'rel.pdf'], dir), [path.join(dir, 'rel.pdf')]);
});

test('extractPdfArgs accepts file: URLs from desktop launchers', () => {
  // The installed desktop entry uses the %U field code, so a file manager
  // hands over a URL rather than a path.
  const dir = fs.realpathSync(tmpdir());
  const plain = path.join(dir, 'doc.pdf');
  const spaced = path.join(dir, 'my paper (final).pdf');
  const devanagari = path.join(dir, 'काठमाडौँ.pdf');
  for (const f of [plain, spaced, devanagari]) fs.writeFileSync(f, MINIMAL_PDF);

  assert.deepEqual(paths.extractPdfArgs(['gloss', pathToFileURL(plain).href], dir), [plain]);
  // Percent-encoded spaces and non-ASCII names must round-trip.
  assert.deepEqual(paths.extractPdfArgs(['gloss', pathToFileURL(spaced).href], dir), [spaced]);
  assert.deepEqual(paths.extractPdfArgs(['gloss', pathToFileURL(devanagari).href], dir), [devanagari]);
});

test('extractPdfArgs rejects every non-file URL scheme', () => {
  const dir = tmpdir();
  for (const url of [
    'https://example.com/x.pdf',
    'http://example.com/x.pdf',
    'ftp://example.com/x.pdf',
    'javascript:alert(1)//x.pdf',
    'data:application/pdf;base64,AAAA',
    'smb://server/share/x.pdf',
  ]) {
    assert.deepEqual(paths.extractPdfArgs(['gloss', url], dir), [], `accepted ${url}`);
  }
});

test('extractPdfArgs drops paths that do not exist or are not files', () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, 'adir.pdf'));
  assert.deepEqual(paths.extractPdfArgs(['gloss', 'missing.pdf'], dir), []);
  assert.deepEqual(paths.extractPdfArgs(['gloss', 'adir.pdf'], dir), []);
});

test('extractPdfArgs tolerates empty and malformed argv', () => {
  assert.deepEqual(paths.extractPdfArgs([], '/tmp'), []);
  assert.deepEqual(paths.extractPdfArgs(undefined, '/tmp'), []);
  assert.deepEqual(paths.extractPdfArgs(['gloss', '', null, 42], '/tmp'), []);
});

// ── readPdfSafely ─────────────────────────────────────────────────────────────

test('readPdfSafely reads a valid PDF and reports its realpath', async () => {
  const dir = fs.realpathSync(tmpdir());
  const pdf = path.join(dir, 'ok.pdf');
  fs.writeFileSync(pdf, MINIMAL_PDF);

  const result = await paths.readPdfSafely(pdf);
  assert.equal(result.ok, true);
  assert.equal(result.realPath, pdf);
  assert.equal(result.name, 'ok.pdf');
  assert.ok(Buffer.isBuffer(result.data));
  assert.equal(result.data.length, result.size);
  assert.ok(paths.isApproved(pdf), 'a successful read approves the realpath');
});

test('readPdfSafely canonicalizes symlinks to their target', async () => {
  const dir = fs.realpathSync(tmpdir());
  const real = path.join(dir, 'real.pdf');
  const link = path.join(dir, 'link.pdf');
  fs.writeFileSync(real, MINIMAL_PDF);
  fs.symlinkSync(real, link);

  const result = await paths.readPdfSafely(link);
  assert.equal(result.ok, true);
  // The approved identity is the target, so swapping the link later cannot
  // redirect a subsequent read to a different file.
  assert.equal(result.realPath, real);
});

test('readPdfSafely rejects non-PDF content regardless of extension', async () => {
  const dir = tmpdir();
  const fake = path.join(dir, 'fake.pdf');
  fs.writeFileSync(fake, 'This is definitely not a PDF file at all.');
  const result = await paths.readPdfSafely(fake);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not_pdf');
});

test('readPdfSafely reports missing, empty, and directory paths distinctly', async () => {
  const dir = tmpdir();
  const missing = await paths.readPdfSafely(path.join(dir, 'nope.pdf'));
  assert.equal(missing.code, 'not_found');
  assert.match(missing.message, /moved or deleted/i);

  const empty = path.join(dir, 'empty.pdf');
  fs.writeFileSync(empty, '');
  assert.equal((await paths.readPdfSafely(empty)).code, 'empty');

  assert.equal((await paths.readPdfSafely(dir)).ok, false);
});

test('readPdfSafely rejects malformed requests without throwing', async () => {
  for (const bad of ['', null, undefined, 42, {}, 'x'.repeat(5000)]) {
    const result = await paths.readPdfSafely(bad);
    assert.equal(result.ok, false, `expected rejection for ${String(bad).slice(0, 20)}`);
  }
});

test('looksLikePdfName accepts only .pdf names', () => {
  assert.equal(paths.looksLikePdfName('a.pdf'), true);
  assert.equal(paths.looksLikePdfName('A.PDF'), true);
  assert.equal(paths.looksLikePdfName('a.pdf.exe'), false);
  assert.equal(paths.looksLikePdfName('pdf'), false);
  assert.equal(paths.looksLikePdfName(null), false);
});

// ── Windows paths ─────────────────────────────────────────────────────────────

test('a Windows drive path is a path, not a URL with a one-letter scheme', () => {
  // Explorer, "Open with" and the command line all hand over drive paths.
  // Reading "C:" as a URL scheme rejected every one of them.
  const cwd = 'C:\\Users\\reader';
  assert.equal(paths.toLocalPath('C:\\Books\\My Paper (final).pdf', cwd, 'win32'),
    'C:\\Books\\My Paper (final).pdf');
  assert.equal(paths.toLocalPath('D:/books/a.pdf', cwd, 'win32'), 'D:\\books\\a.pdf');
  assert.equal(paths.toLocalPath('notes\\a.pdf', cwd, 'win32'), 'C:\\Users\\reader\\notes\\a.pdf');
  assert.equal(paths.toLocalPath('\\\\server\\share\\a.pdf', cwd, 'win32'), '\\\\server\\share\\a.pdf');
  assert.equal(paths.toLocalPath('file:///C:/Users/reader/My%20Books/a.pdf', cwd, 'win32'),
    'C:\\Users\\reader\\My Books\\a.pdf');
});

test('remote schemes are still refused on Windows, and drive syntax means nothing elsewhere', () => {
  for (const url of ['https://example.com/a.pdf', 'ftp://host/a.pdf', 'javascript:alert(1)', 'data:application/pdf,x']) {
    assert.equal(paths.toLocalPath(url, 'C:\\Users\\reader', 'win32'), null);
  }
  // "C:a.pdf" (drive-relative) is ambiguous and not something a launcher sends.
  assert.equal(paths.toLocalPath('C:a.pdf', 'C:\\Users\\reader', 'win32'), null);
  // On POSIX a colon-led token keeps being treated as a (non-file) scheme.
  assert.equal(paths.toLocalPath('C:\\Books\\a.pdf', '/home/reader', 'linux'), null);
  assert.equal(paths.toLocalPath('-C:\\a.pdf', 'C:\\', 'win32'), null);
});
