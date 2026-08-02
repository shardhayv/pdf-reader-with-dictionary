# Testing

```bash
npm run fixtures     # generate test PDFs (required once, before the first run)
npm run test:unit    # node:test — pure logic
npm run test:e2e     # Playwright + Electron — the real app
npm test             # both
```

---

## Fixtures

Test PDFs are generated, not committed (`test/fixtures/` is gitignored).
`npm run fixtures` produces five:

| Fixture | Built by | Exercises |
|---|---|---|
| `latin.pdf` | direct PDF writer | basic opening, Latin search |
| `large.pdf` | direct PDF writer, 300 pages | virtualization bounds, navigation, search timing |
| `devanagari.pdf` | HarfBuzz + hand-written ToUnicode | Devanagari selection, copy, search, conjuncts |
| `garbled.pdf` | Chromium `printToPDF` | the broken-`ToUnicode` detection path |
| `scanned.pdf` | Chromium `printToPDF` | image-only documents with no text layer |

### Why the Devanagari fixture is built by hand

This was the least obvious part of the work. **No available HTML-to-PDF
pipeline produces a Devanagari PDF whose text extracts correctly.** Both were
measured against pdf.js:

- **Chromium `printToPDF`** shapes the text beautifully but writes `ToUnicode`
  maps in which ligature glyphs reverse to `U+0000`. `क्षेत्र`, `हिन्दी`, and
  `संस्कृत` all extract as NUL soup.
- **LibreOffice** is worse: it emits glyphs in visual rather than logical order,
  so words come back scrambled.

`scripts/make-devanagari-fixture.py` therefore builds the PDF directly: it
shapes each line with HarfBuzz (so conjuncts and matras render correctly), then
writes a `ToUnicode` CMap it controls. Two details make it correct:

1. Each distinct *(glyph, source text)* pair gets its own CID, mapped to a real
   glyph through a `CIDToGIDMap` stream, so a glyph reused for different text
   cannot collide in the map.
2. A cluster's characters are distributed across its glyphs in **logical**
   order. HarfBuzz emits glyphs in visual order, but concatenating the labels in
   glyph order still reproduces the original string. Every glyph must get a
   non-empty entry: pdf.js reads `toUnicode.get(code) || code`, so an empty
   destination silently falls back to the raw character code and injects
   garbage — which is exactly the bug that made the first attempt fail.

The generator asserts a round-trip on every line and refuses to write a fixture
that does not reproduce its source text.

That Chromium failure is not wasted: `garbled.pdf` is the same document, and it
is a genuine real-world example of a PDF that renders perfectly while carrying
broken text data — the case the app has to detect and explain.

Requirements: `python3-gi` with the HarfBuzz typelib, `fontTools`, and a Noto
Devanagari font. If any is missing the generator skips that fixture with a
message rather than failing the build.

---

## Sandbox and the test harness

The Electron binary in `node_modules` ships a non-setuid `chrome-sandbox`, and
Ubuntu 24.04+ restricts unprivileged user namespaces, so the development build
cannot sandbox itself and correctly refuses to start.

`test/e2e/helpers.js` passes `--no-sandbox` **to the harness only**. The
application never disables its own sandbox, and packaged `.deb` builds install a
setuid helper. To run the suite fully sandboxed, fix the helper once and set the
opt-in flag:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
GLOSS_TEST_SANDBOX=1 npm run test:e2e
```

Each spec launches with its own temporary `--user-data-dir`, so tests never read
or write your real preferences and recent documents.

---

## What the suites cover

**`test/unit/text.test.js`** — grapheme integrity for conjuncts, matras, nukta,
chandrabindu and joiners; word segmentation; Unicode-aware edge trimming
(including danda); the candidate ladder (exact-first, Latin-only casing, NFC
variants for precomposed nukta forms); auto-lookup gating; the search index,
including offset round-tripping and words split across text items; text-quality
classification.

**`test/unit/paths.test.js`** — argv parsing (flags rejected, relative paths
resolved against the caller's cwd, nonexistent and non-file paths dropped);
`readPdfSafely` realpath canonicalization, magic-byte sniffing, size and
emptiness handling, and distinct error codes.

**`test/e2e/security.spec.js`** — 25 hostile dictionary payloads through the
real sanitizer; link rewriting to inert `data-*` attributes; the exact
`window.gloss` surface (widening it fails the test); window security
preferences; navigation and `window.open` denial; `openExternal` scheme
filtering; malformed-IPC resilience; and the absence of any arbitrary-file-read
path.

**`test/e2e/reader.spec.js`** — opening via command line; second-instance
focusing; page navigation, zoom modes and shortcuts; bounded page mounting
across a 300-page document; Latin and Devanagari search including a conjunct
split across text items; Devanagari selection and copy fidelity asserted at the
code-point level; exactly one lookup per selection; stale-response suppression;
scanned and broken-mapping notices; and per-document state restoration.

---

## Visual verification

Automated tests do not judge design. `node scripts/screenshots.js` captures
twelve states — empty, reading, lookup, search, sidebar, preferences, narrow
window, and the scanned notice — in both themes, into `test/screenshots/`.

Worth checking by eye after any CSS change:

- Devanagari headwords in the popup are not clipped above or below (matras and
  chandrabindu need the generous line height).
- The popup sits near the selection without covering the line being read.
- Focus rings are visible on every control, in both themes.
- The toolbar stays on one row down to about 680 px wide.
- With `prefers-reduced-motion`, nothing animates and programmatic scrolling
  jumps rather than smooth-scrolls.

---

## Adding tests

Put pure logic in `renderer/js/text.js` and test it in `test/unit/` — it has no
DOM or Electron dependency, so those tests run in milliseconds. Reserve the
Playwright suites for behaviour that genuinely needs the app: IPC, rendering,
selection, and the security boundaries.
