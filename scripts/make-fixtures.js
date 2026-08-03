#!/usr/bin/env node
'use strict';
/**
 * Generates the PDF fixtures the test suite needs, into test/fixtures/
 * (gitignored — these are build artifacts, not source).
 *
 *   latin.pdf       small Latin document with known words
 *   encrypted.pdf   latin.pdf protected with user password "gloss"
 *   devanagari.pdf  Devanagari + Latin, rendered by Chromium so the text
 *                   carries real ToUnicode maps and extracts as Unicode
 *   large.pdf       300 pages, for virtualization and search timing
 *   scanned.pdf     an image-only page (no text layer at all)
 *   links.pdf       external URL and internal page-jump link annotations
 *
 * Latin/large PDFs are written directly (deterministic, no GUI needed).
 * The Devanagari and scanned fixtures need Chromium's printToPDF, so this
 * script runs under Electron: `npm run fixtures`.
 */

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'test', 'fixtures');

// ── Minimal PDF writer (Helvetica, WinAnsi — Latin only) ─────────────────────

/**
 * `annots` is optional and parallel to `pages`: a list per page of
 *   { line, url }        an external link over that text line, or
 *   { line, destPage }   a jump to another page (1-based).
 * Destination page ids are not known until the page objects exist, so they
 * are emitted as tokens and patched at the end, like /Parent below.
 */
function buildLatinPdf(pages, annots = []) {
  const objects = [];
  const add = (body) => objects.push(body) && objects.length;

  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const pageIds = [];
  const contentIds = [];

  for (const lines of pages) {
    const escaped = lines.map(l => l.replace(/([\\()])/g, '\\$1'));
    const stream = `BT /F1 12 Tf 72 720 Td 18 TL\n${escaped.map(l => `(${l}) Tj T*`).join('\n')}\nET`;
    contentIds.push(add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`));
    pageIds.push(0); // placeholder, filled below
  }

  // Allocated before the /Pages id is predicted below, so that prediction holds.
  const annotIds = pages.map((_, i) => (annots[i] || []).map((a) => {
    // Text starts at y=720 with 18pt leading; line 0 is the first line.
    const baseline = 720 - 18 * a.line;
    const rect = `[72 ${baseline - 4} 320 ${baseline + 12}]`;
    const action = a.url
      ? `/A << /S /URI /URI (${a.url.replace(/([\\()])/g, '\\$1')}) >>`
      : `/Dest [ @@PAGE${a.destPage}@@ 0 R /XYZ null null null ]`;
    return add(`<< /Type /Annot /Subtype /Link /Rect ${rect} /Border [0 0 0] ${action} >>`);
  }));

  const pagesId = objects.length + pages.length + 1;
  for (let i = 0; i < pages.length; i++) {
    const annotsEntry = annotIds[i].length
      ? ` /Annots [${annotIds[i].map(id => `${id} 0 R`).join(' ')}]`
      : '';
    pageIds[i] = add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentIds[i]} 0 R${annotsEntry} >>`
    );
  }
  const realPagesId = add(
    `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`
  );
  const catalogId = add(`<< /Type /Catalog /Pages ${realPagesId} 0 R >>`);

  // Re-point page parents now that the real /Pages id is known.
  for (const id of pageIds) {
    objects[id - 1] = objects[id - 1].replace(/\/Parent \d+ 0 R/, `/Parent ${realPagesId} 0 R`);
  }
  // …and resolve destination tokens now that every page object id is known.
  for (let i = 0; i < objects.length; i++) {
    objects[i] = objects[i].replace(/@@PAGE(\d+)@@/g, (_m, p) => String(pageIds[Number(p) - 1]));
  }

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// ── Fixture content ──────────────────────────────────────────────────────────

const LATIN_PAGES = [
  [
    'Gloss test document',
    '',
    'The word serendipity appears on this line.',
    'A cafe in Paris was visited by NASA researchers.',
    'Ubiquitous quotidian ephemeral perspicacious.',
    'This sentence contains the term Paris twice: Paris.',
  ],
  [
    'Second page of the Latin fixture.',
    '',
    'Another occurrence of serendipity lives here.',
    'Hyphenated-word and apostrophe: doesn\'t.',
  ],
];

/**
 * Link-annotation fixture. Line 2 of page 1 is an external URL, line 4 jumps
 * to page 2, and line 6 is ordinary text used to prove that a click off a
 * link does nothing and that selection still works over a linked line.
 */
const LINK_PAGES = [
  [
    'Gloss link fixture',
    '',
    'External link to example dot org.',
    '',
    'Internal link jumping to page two.',
    '',
    'Plain unlinked text on this line.',
  ],
  [
    'Second page of the link fixture.',
    '',
    'The destination of the internal link.',
  ],
];

const LINK_ANNOTS = [
  [{ line: 2, url: 'https://example.org/gloss-link-test' }, { line: 4, destPage: 2 }],
  [],
];

const DEVANAGARI_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 20mm; }
  body { font-family: 'Noto Serif Devanagari', 'Noto Sans Devanagari', serif;
         font-size: 15pt; line-height: 2; color: #000; }
  h1 { font-size: 20pt; margin-bottom: 18pt; }
  p { margin: 0 0 10pt; }
  .latin { font-family: 'Noto Serif', Georgia, serif; }
</style></head><body>
  <h1>ग्लॉस परीक्षण दस्तावेज़</h1>
  <p>काठमाडौँ नेपालको राजधानी हो ।</p>
  <p>हिन्दी और संस्कृत दोनों देवनागरी लिपि में लिखी जाती हैं ।</p>
  <p>प्रज्ञा और क्षेत्र जैसे संयुक्ताक्षर सही रहने चाहिए ।</p>
  <p>नेपाल एक सुन्दर देश है ॥</p>
  <p>देवनागरी अंक: ०१२३४५६७८९ ।</p>
  <p>क़िला और क़लम में नुक़्ता है ।</p>
  <p class="latin">A café in Paris, studied by NASA. Serendipity.</p>
  <p>यह वाक्य काठमाडौँ शब्द को दोहराता है: काठमाडौँ ।</p>
</body></html>`;

// An "image-only" page: ink-like bars drawn as boxes, so the PDF has
// graphics but no extractable text — what a scan looks like to pdf.js.
const SCANNED_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 18mm; }
  body { margin: 0; background: #fdfdfb; }
  .bar { height: 7px; border-radius: 2px; background: #3a3a3a; opacity: 0.82; margin-bottom: 13px; }
</style></head><body>
  ${Array.from({ length: 24 }, (_, i) =>
    `<div class="bar" style="width: ${52 + ((i * 37) % 46)}%"></div>`
  ).join('')}
</body></html>`;

// ── Runner ───────────────────────────────────────────────────────────────────

const CHROMIUM_FIXTURES = {
  // Chromium shapes Devanagari correctly but writes ToUnicode maps that
  // reverse conjunct glyphs to NUL — a real-world broken-text-mapping PDF,
  // so it doubles as the fixture for the "garbled text" detection path.
  'garbled.pdf': { html: DEVANAGARI_HTML, options: {} },
  'scanned.pdf': { html: SCANNED_HTML, options: { margins: { marginType: 'none' } } },
};

/**
 * Render one HTML fixture to PDF. Runs inside Electron, one fixture per
 * process: a second BrowserWindow load in the same process fails on some
 * Linux/Wayland setups, so the parent spawns us once per fixture.
 */
async function renderOne(name) {
  const { app, BrowserWindow } = require('electron');
  const os = require('os');
  const spec = CHROMIUM_FIXTURES[name];
  if (!spec) throw new Error(`unknown fixture: ${name}`);

  await app.whenReady();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-fixtures-'));
  // The temp name must not contain ".pdf" — Chromium routes anything that
  // looks like a PDF to its plugin, and the HTML load then fails.
  const tmpHtml = path.join(tmpDir, `${path.basename(name, '.pdf')}.html`);
  fs.writeFileSync(tmpHtml, spec.html, 'utf8');

  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await win.loadFile(tmpHtml);
  await new Promise(r => setTimeout(r, 400)); // let fonts settle
  const buffer = await win.webContents.printToPDF({
    pageSize: 'A4', printBackground: true, ...spec.options,
  });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name), buffer);
  win.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`wrote ${name}`);
  app.quit();
}

function writePlainFixtures() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  fs.writeFileSync(path.join(OUT_DIR, 'latin.pdf'), buildLatinPdf(LATIN_PAGES));
  console.log('wrote latin.pdf');
  buildEncryptedFixture();

  const largePages = Array.from({ length: 300 }, (_, i) => [
    `Page ${i + 1} of the large fixture`,
    '',
    `This page repeats the marker word alpha${i + 1} exactly once.`,
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
    'Sed do eiusmod tempor incididunt ut labore et dolore magna.',
    ...Array.from({ length: 24 }, (_, j) => `Line ${j + 1}: the quick brown fox jumps over the lazy dog.`),
  ]);
  fs.writeFileSync(path.join(OUT_DIR, 'large.pdf'), buildLatinPdf(largePages));
  console.log('wrote large.pdf (300 pages)');

  fs.writeFileSync(path.join(OUT_DIR, 'links.pdf'), buildLatinPdf(LINK_PAGES, LINK_ANNOTS));
  console.log('wrote links.pdf');
}

/**
 * Build a real encrypted-PDF oracle when Ghostscript is available. The test
 * suite skips only this fixture's flow if a contributor cannot generate it.
 */
function buildEncryptedFixture() {
  const { spawnSync } = require('child_process');
  const input = path.join(OUT_DIR, 'latin.pdf');
  const output = path.join(OUT_DIR, 'encrypted.pdf');
  const result = spawnSync('gs', [
    '-q', '-sDEVICE=pdfwrite', '-dBATCH', '-dNOPAUSE',
    '-sUserPassword=gloss', '-sOwnerPassword=gloss-owner',
    '-dEncryptionR=3', '-dKeyLength=128',
    `-sOutputFile=${output}`, input,
  ], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') {
    console.warn('skipped encrypted.pdf — Ghostscript (gs) is not installed');
    return;
  }
  if (result.status !== 0) {
    console.warn(`skipped encrypted.pdf — Ghostscript failed: ${(result.stderr || '').trim()}`);
    return;
  }
  console.log('wrote encrypted.pdf (password: gloss)');
}

function spawnChromiumFixtures() {
  const { spawnSync } = require('child_process');
  const electronBin = require(path.join(__dirname, '..', 'node_modules', 'electron'));
  // The dev sandbox helper is not setuid on this class of Linux system;
  // this switch applies to the fixture generator only, never to the app.
  const sandboxArgs = process.env.GLOSS_FIXTURE_SANDBOX === '1' ? [] : ['--no-sandbox'];

  for (const name of Object.keys(CHROMIUM_FIXTURES)) {
    const r = spawnSync(electronBin, [...sandboxArgs, __filename, '--render', name], {
      stdio: ['ignore', 'inherit', 'pipe'],
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      console.error(`failed to render ${name}`);
      if (r.stderr) console.error(r.stderr.split('\n').filter(l => /Error|failed/i.test(l)).join('\n'));
      process.exitCode = 1;
    }
  }
}

const renderFlag = process.argv.indexOf('--render');
if (renderFlag !== -1) {
  renderOne(process.argv[renderFlag + 1]).catch(err => {
    console.error('fixture render failed:', err.message);
    process.exit(1);
  });
} else {
  writePlainFixtures();
  spawnChromiumFixtures();
  buildDevanagariFixture();
}

/**
 * The well-formed Devanagari fixture needs HarfBuzz shaping plus a
 * hand-written ToUnicode CMap (no HTML-to-PDF pipeline available produces
 * correct reverse mappings for conjuncts). Built by a small Python script.
 */
function buildDevanagariFixture() {
  const { spawnSync } = require('child_process');
  const script = path.join(__dirname, 'make-devanagari-fixture.py');
  const font = [
    '/usr/share/fonts/truetype/noto/NotoSerifDevanagari-Regular.ttf',
    '/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf',
  ].find(p => fs.existsSync(p));

  if (!font) {
    console.warn('skipped devanagari.pdf — no Noto Devanagari font found ' +
      '(install fonts-noto-core)');
    return;
  }
  const r = spawnSync('python3', [script, font, path.join(OUT_DIR, 'devanagari.pdf')], {
    stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.warn('skipped devanagari.pdf — generator failed. Needs python3-gi ' +
      '(HarfBuzz typelib) and fontTools.');
    if (r.stderr) console.warn(r.stderr.trim().split('\n').slice(-3).join('\n'));
  }
}
