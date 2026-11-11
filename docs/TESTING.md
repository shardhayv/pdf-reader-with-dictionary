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
`npm run fixtures` produces seven (the encrypted fixture is optional if
Ghostscript is unavailable):

| Fixture | Built by | Exercises |
|---|---|---|
| `latin.pdf` | direct PDF writer | basic opening, Latin search |
| `encrypted.pdf` | Ghostscript from `latin.pdf` | real wrong/correct/cancel password flow (password `gloss`) |
| `large.pdf` | direct PDF writer, 300 pages | virtualization bounds, navigation, search timing |
| `devanagari.pdf` | HarfBuzz + hand-written ToUnicode | Devanagari selection, copy, search, conjuncts |
| `garbled.pdf` | Chromium `printToPDF` | the broken-`ToUnicode` detection path |
| `scanned.pdf` | Chromium `printToPDF` | image-only documents with no text layer |
| `links.pdf` | direct PDF writer | external URL and internal page-jump link annotations |

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
Devanagari font. Ghostscript (`gs`) builds the encrypted fixture. If an optional
tool is missing, the generator skips only that fixture with a message.

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
or write your real preferences and recent documents. The harness also sets
`GLOSS_NO_BUNDLED_DICTIONARIES=1`: a checkout that has the packaged
dictionaries in `bundled-dictionaries/` would otherwise seed them into every
run and break specs that assert exact dictionary lists and lookup results.

The suite opens real windows. On Linux, keep them off your desktop with a
virtual display:

```bash
xvfb-run -a -s "-screen 0 2560x1600x24" npm run test:e2e
```

---

## What the suites cover

**`test/unit/text.test.js`** — grapheme integrity for conjuncts, matras, nukta,
chandrabindu and joiners; word segmentation; Unicode-aware edge trimming
(including danda); the candidate ladder (exact-first, Latin-only casing, NFC
variants for precomposed nukta forms); base forms — English inflections,
possessives and compounds, Nepali postpositions and verb forms, Hindi plural
endings — always after the exact forms, conservative before aggressive, and
never cutting a conjunct; auto-lookup gating; the search index,
including offset round-tripping and words split across text items; text-quality
classification.

**`test/unit/paths.test.js`** — argv parsing (flags rejected, relative paths
resolved against the caller's cwd, nonexistent and non-file paths dropped,
Windows drive and UNC paths accepted as paths rather than rejected as
one-letter URL schemes);
`readPdfSafely` realpath canonicalization, magic-byte sniffing, size and
emptiness handling, and distinct error codes.

**`test/unit/glossary.test.js`** — versioned and legacy JSON parsing; exact,
alias, NFC and Devanagari lookup; an alias never hiding a real headword; book path/fingerprint scoping; global scope;
draft counts; contextual occurrences; value limits; and malformed-file errors.

**`test/unit/glossary-builder.test.js`** — English/Devanagari candidate quality,
short conjunct headwords, recurring terms, hyphenated compounds, common-word
filtering, grapheme-safe context, recovery of synthetic nukta/virama word
splits, scan/garbled-PDF refusal, safe AI-definition merge, `.bak` recovery,
and refusal to overwrite the source PDF.

**`test/unit/mdx-worker.test.js`** — proves a deliberately synchronous parser
does not block the caller's event loop, exact/proper-case lookup remains ordered,
parser/worker failures reject without taking down the app process, and a timed-out
lookup retires its stuck worker instead of poisoning later lookups.

**`test/unit/store.test.js`** — corrupt preference/history files are preserved
as timestamped backups, safe defaults load, and the primary files can be
repaired without touching those recovery copies; the saved reading position
and the packaged-dictionary record are validated and not renderer-writable.

**`test/unit/dicts.test.js`** — candidate ordering and priority across MDX and
JSON sources, book scoping, transactional reload, and the packaged-dictionary
rules: offered once, a removed one stays removed, a moved package is followed
with its on/off state, a reader's own copy is never duplicated, general
English is seeded first, and a dictionary a newer build no longer ships is
dropped without an error.

**`test/e2e/security.spec.js`** — 25 hostile dictionary payloads through the
real sanitizer; link rewriting to inert `data-*` attributes; the exact
`window.gloss` surface (widening it fails the test); window security
preferences; navigation and `window.open` denial; `openExternal` scheme
filtering; malformed-IPC resilience; and the absence of any arbitrary-file-read
path.

**`test/e2e/reader.spec.js`** — opening via command line; second-instance
focusing; page navigation, zoom modes and shortcuts; page rotation, reading
history back/forward, page paper tint, and document properties; bounded page
mounting across a 300-page document; Latin and Devanagari search including a
conjunct split across text items; Devanagari selection and copy fidelity
asserted at the code-point level against Electron's real clipboard (restored
afterwards); exactly one lookup per selection; stale-response suppression;
scanned and broken-mapping notices; and per-document state restoration.

**`test/e2e/glossary.spec.js`** — loading through the real dialog, aliases and
Devanagari popup rendering, automatic PDF-specific activation, global priority,
transactional live reload, draft behavior, and sanitizer parity with MDX.

**`test/e2e/responsive.spec.js`** — drives the real window through eight
widths from 1600 px to the 420 px minimum with a twelve-dictionary shelf and
asserts no toolbar control is clipped, overlapping, wrapped or off-screen, and
that folded tools work from the More menu; the Sources checklist; clipboard
copy against Electron's real clipboard and the exact text a saved word keeps;
Space/arrow keys acting on the focused control and nothing reaching the
document through an open dialog; a zoomed page being fully scrollable; zoom
and resize holding the reader's place 200 pages in; the reading position
surviving a reopen at a different window size; printing producing one sheet
per page at the document's page size (verified through `printToPDF`); and the
definition popup never overlapping the selected word in short or narrow
windows.

**`test/e2e/integration.spec.js`** — dialog/drop/recents paths, keyboard and
reduced-motion states, password UI, plus recovery from a failed file portal, a
corrupt saved glossary, an unexpected renderer promise rejection, a failed MDX
lookup, and a real forced Chromium renderer crash that reopens the PDF at its
saved page and remains interactive.

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
- The toolbar stays on one row at every width down to 420 px, folding tools
  into the More menu (this one is also asserted by `responsive.spec.js`).
- With `prefers-reduced-motion`, nothing animates and programmatic scrolling
  jumps rather than smooth-scrolls.

---

## Adding tests

Put pure logic in `renderer/js/text.js`, `main/glossary.js`, or
`scripts/glossary-builder.mjs` and test it in `test/unit/`. Reserve the
Playwright suites for behaviour that genuinely needs the app: IPC, rendering,
selection, recovery surfaces, and security boundaries.
