<div align="center">

# Gloss

**A quiet PDF reader for people who read to understand**

*Select a word — in English or Devanagari — and its meaning appears in the margin.*

![Electron](https://img.shields.io/badge/Electron-45-47848F?style=flat&logo=electron&logoColor=white)
![PDF.js](https://img.shields.io/badge/PDF.js-6.5-orange?style=flat)
![Platform](https://img.shields.io/badge/Platform-Linux%20%7C%20Windows-E95420?style=flat&logo=linux&logoColor=white)
![License](https://img.shields.io/badge/License-AGPL--3.0-blue?style=flat)

Created and maintained by **[Shardhay Vatshyayan](https://github.com/shardhayv)**.

</div>

---

## What Gloss is

Gloss is a desktop PDF reader built around one idea: when you don't know a word,
looking it up should take one gesture, not ten. Select any word and a definition
appears next to it — from **your own MDX dictionaries**, with **Wiktionary** and
**Wikipedia** as optional online fallbacks. For each book, Gloss can also use a
small **AI-assisted JSON glossary** containing the names, coined words, and
context-specific meanings that no general dictionary knows.

The three tiers answer different questions, in this order:

1. **Your dictionaries and glossaries** — offline, yours, always first.
2. **Wiktionary** — *what does this word mean*: senses, part of speech, usage.
3. **Wikipedia** — *what is this thing*: the encyclopedia article behind a name.

Between them there is rarely a reason to leave the reader for a search engine.
When there is, a **Search the web** link in the popup hands the word to your
browser — nothing is sent anywhere until you click it.

It works equally well with Latin and Devanagari text. Selecting `काठमाडौँ` gives
you the whole word, chandrabindu and all; searching for `क्षेत्र` finds it even
when the conjunct is split across two internal text runs. Devanagari headwords
come back from Wiktionary glossed in English — `जल` yields the Hindi, Nepali and
Sanskrit senses side by side.

Dictionary and glossary lookups are entirely local. Wiktionary and Wikipedia are
the only requests Gloss makes on its own, and only when you ask for a word. There
are no accounts, no telemetry, and no analytics.

---

## Features

| | |
|---|---|
| **Instant lookup** | Select a word or short phrase; the definition appears without covering the line you're reading |
| **Latin and Devanagari** | Unicode-aware selection, search, and lookup that never split a conjunct or drop a matra |
| **Your dictionaries** | Load any number of `.mdx` files without freezing the reader, set their priority, toggle them per lookup |
| **Per-book glossaries** | Build an AI-assisted JSON glossary for one PDF; it activates automatically only for that book |
| **Wiktionary meanings** | Optional online dictionary: senses, part of speech, examples, with in-popup cross-references |
| **Wikipedia fallback** | Optional, in English, Hindi, Nepali, or Maithili |
| **Search the web** | Opt-out link that opens the word in your browser — the only thing Gloss ever hands a search engine |
| **Rich definition popup** | Pin, drag anywhere on screen, save words (`S`), copy definitions in one click, or switch sources with `1`–`9` |
| **Vocabulary & bookmarks** | Save looked-up words to a persistent vocabulary notebook (with Markdown export) and bookmark pages (`Ctrl+B`) in the `Saved` sidebar |
| **Two-page book spread** | Switch between a single-page column and a side-by-side two-page book spread (`V`), remembered per document |
| **Big documents** | Only a handful of pages are ever in memory, so a 300-page PDF opens instantly |
| **Clickable links** | Link annotations open in your browser or jump within the document; double-click still defines the word |
| **Reading history** | Jump to an internal link, outline heading, or search hit and return with `Alt+←` / `Alt+→` |
| **Find in document** | Unicode-aware search with result counts and highlighting |
| **Pages, outline & saved** | Lazy thumbnail sidebar, the document's table of contents, and your bookmarked pages + saved vocabulary |
| **Zoom & rotation** | Fit width, fit page, free zoom with `Ctrl`+wheel anchored under the cursor, and per-book 90° rotation (`R`) |
| **Page paper tint** | Read on Original, Warm paper, Sepia, or inverted Night page (`Ctrl+Shift+D`) to reduce eye strain |
| **Document info & print** | Inspect PDF metadata, page dimensions, and file size (`Ctrl+I`), or print (`Ctrl+P`) |
| **Picks up where you left off** | Page, zoom, rotation, spread layout, bookmarks, and scroll position are remembered per document |
| **Reads like a native app** | Drag-and-drop, file associations, recent documents, reading progress bar, remembered window position |
| **Light, dark, or system** | Plus reduced-motion support and full keyboard access |

---

## Requirements

- Linux x86_64 (developed and verified on Ubuntu 26.04, GNOME/Wayland)
- Node.js 20.19 or newer to build from source (Node 24 recommended) — PDF.js
  and Playwright require Node 20, ESLint 10 requires 20.19

Devanagari rendering uses your system fonts. On Debian/Ubuntu:

```bash
sudo apt install fonts-noto-core
```

---

## Install and run from source

```bash
git clone https://github.com/shardhayv/pdf-reader-with-dictionary.git
cd pdf-reader-with-dictionary
npm install
npm start
```

### If the app refuses to start

On Ubuntu 24.04 and newer, unprivileged user namespaces are restricted by
AppArmor, and the Electron binary in `node_modules` ships a `chrome-sandbox`
helper that is not setuid. Electron then refuses to run rather than start
unsandboxed — which is the correct thing for it to do. Fix the helper once:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

Repeat this after reinstalling Electron. **Do not** pass `--no-sandbox` to work
around it: that disables a real security boundary. Installed `.deb` builds set
this up correctly at install time and need no such step.

---

## Packaging & Downloads

Prebuilt releases for Linux and Windows are available directly on the [GitHub Releases](https://github.com/shardhayv/pdf-reader-with-dictionary/releases) page:

- **Windows**:
  - `Gloss-2.4.0-Setup.exe` — Full Windows installer with start menu & desktop shortcuts and PDF file association.
  - `Gloss-2.4.0-Portable.exe` — Standalone portable executable (runs from anywhere, e.g. USB drive, no installation required).
  - *Both Windows builds come **pre-bundled with all 12 offline dictionaries** (`361,000+` entries) ready to use on first launch.*
- **Linux**:
  - `gloss_2.4.0_amd64.deb` — Debian/Ubuntu package with desktop integration and sandboxing.

### Build from source

```bash
# Linux
npm run dist:deb        # Debian/Ubuntu package (.deb)
npm run dist:appimage   # AppImage only
npm run dist            # AppImage + .deb

# Windows (builds on Linux via Wine/makensis or natively on Windows)
npm run dist:win        # Both NSIS installer and Portable .exe
npm run dist:win:nsis   # NSIS installer (.exe)
npm run dist:win:portable # Portable single-file executable (.exe)
```

Install and run the `.deb` on Ubuntu/Debian:

```bash
sudo apt install ./dist/gloss_2.4.0_amd64.deb
gloss                      # or launch from your applications menu
gloss ~/Documents/paper.pdf
```

The package registers Gloss as a PDF viewer, installs a desktop entry and
icons, and makes `chrome-sandbox` setuid so the sandbox works on systems with
restricted user namespaces.

**AppImage caveat:** an AppImage is mounted read-only and owned by the invoking
user, so its `chrome-sandbox` can never be setuid. On distributions that also
restrict unprivileged user namespaces (Ubuntu 24.04+), the AppImage cannot
sandbox itself. Prefer the `.deb` there, or install an AppArmor profile that
permits `userns` for the AppImage path. The `.deb` is the recommended artifact
for Ubuntu and Debian.

---

## Using Gloss

1. **Open a PDF** — the toolbar button, `Ctrl+O`, drag a file onto the window,
   pass a path on the command line, or open it from your file manager.
2. **Add dictionaries** — Preferences → Dictionaries → *Add dictionaries…* and
   pick one or more lawfully obtained `.mdx` files or global `.json` glossaries.
   Open, public-domain, and personally licensed dictionaries can all be used;
   Gloss does not bundle or redistribute dictionary data in its packages.

   To download and auto-register a complete suite of **12 offline category-wise
   and Devanagari dictionaries** (`361,000+` entries across Computer Science &
   AI, Philosophy & Logic, Economics & Finance, Politics & Law, History &
   Civilizations, Biology & Medicine, Chemistry & Materials, Mathematics &
   Physics, Psychology & Linguistics, General English WordNet 3.1, Devanagari
   Hindi & Sanskrit Dictionary, and Nepali Brihat Shabdakosh):

   ```bash
   npm run dictionaries
   ```

   You can also add a **per-book glossary** — a small JSON file for the words a
   general dictionary cannot help with. Build a draft from the book itself:

   ```bash
   npm run glossary -- ~/books/thebook.pdf --list   # preview the candidates
   npm run glossary -- ~/books/thebook.pdf          # write the draft
   ```

   Give the draft to an AI to fill `definition` and useful `aliases`, review a
   batch, then add the file the same way. Entries left blank are ignored, so a
   partly finished glossary is perfectly usable. Regenerating safely merges new
   vocabulary without erasing completed definitions and keeps a `.bak`; edits
   can be picked up with the Reload button. See
   [docs/GLOSSARIES.md](docs/GLOSSARIES.md).
3. **Look up a word** — select it. Lookups only ever trigger from text inside the
   document, never from the interface. Use `Ctrl+D` to force a lookup of a longer
   selection, and pin the result if you want it to stay open while you read.
4. **Search** — `Ctrl+F`, then `Enter` / `Shift+Enter` to step through results.
5. **Read** — `F11` hides everything but the page.

### Keyboard

| Key | Action |
|---|---|
| `Ctrl+O` | Open a PDF |
| `Ctrl+F` | Find in document |
| `Enter` / `Shift+Enter` | Next / previous result (in the find bar) |
| `Ctrl+D` | Look up the current selection |
| `S` | Save / unsave the current word to your vocabulary notebook (when popup is open) |
| `1`–`9` | Switch dictionary source tabs (when popup is open) |
| `Ctrl` `+` / `-` | Zoom in / out |
| `Ctrl+0` | Fit width |
| `Ctrl+Shift+0` | Fit page |
| `Ctrl` + mouse wheel | Zoom around the cursor |
| `V` | Toggle two-page book spread view |
| `R` / `Shift+R` | Rotate clockwise / counter-clockwise |
| `Ctrl+B` | Bookmark / unbookmark the current page |
| `Alt+←` / `Alt+→` | Back / forward in reading history |
| `Ctrl+Shift+D` | Cycle page paper tint (Original / Warm / Sepia / Night) |
| `Ctrl+I` | Document properties |
| `Ctrl+P` | Print |
| `F9` | Pages, outline, and saved sidebar |
| `F11` | Read mode |
| `Ctrl+,` | Preferences |
| `PageUp` / `PageDown` / `Home` / `End` | Scroll |
| `←` / `→` | Previous / next page |
| `Escape` | Close the topmost thing only |
| `F1` | About |

---

## How it works

Gloss follows Electron's two-process model with the renderer fully sandboxed.

```
┌──────────────────────────────────────────────────────────────┐
│  Main process — main.js, main/                               │
│  paths.js     which files may be read, and how               │
│  store.js     preferences, per-document state, recents       │
│  dicts.js     dictionary registry and candidate lookup       │
│  glossary.js  JSON glossary backend (one per book)           │
│  mdx-worker*  off-main-thread MDX parsing and lookup          │
│  wiktionary.js  online dictionary tier (network)             │
│  wiki.js      online encyclopedia tier (network)             │
│  security.js  navigation, window, and permission denial      │
│  windows.js   window lifecycle, bounds, menu                 │
│  ipc.js       the entire IPC surface                         │
└───────────────────────────┬──────────────────────────────────┘
                            │ contextBridge — 25 typed methods
┌───────────────────────────▼──────────────────────────────────┐
│  Preload — preload.js  (sandboxed, context-isolated)         │
│  Resolves dropped files to paths; exposes window.gloss       │
└───────────────────────────┬──────────────────────────────────┘
                            │ window.gloss.*
┌───────────────────────────▼──────────────────────────────────┐
│  Renderer — renderer/js/                                     │
│  app.js       composition root, keyboard layers              │
│  viewer.js    document lifecycle, virtualized rendering      │
│  text.js      Unicode segmentation, candidates, search index │
│  selection.js decides when a selection becomes a lookup      │
│  links.js     decides when a PDF link becomes an action      │
│  lookup.js    lookup orchestration and race prevention       │
│  popup.js     sanitization and the definition surface        │
│  search.js    find-in-document                               │
│  sidebar.js   thumbnails and outline                         │
│  prefsModal.js, dom.js, icons.js                             │
└──────────────────────────────────────────────────────────────┘
```

`renderer/js/text.js` has no DOM or Electron dependencies, so the Unicode
behaviour that matters most is testable in plain Node.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design decisions behind
the virtualized renderer, the lookup candidate ladder, and the security model;
[docs/GLOSSARIES.md](docs/GLOSSARIES.md) for building per-book glossaries; and
[docs/TESTING.md](docs/TESTING.md) for how to run and extend the tests.

---

## Tests

```bash
npm run fixtures     # generate test PDFs (once; they are not committed)
npm run test:unit    # Unicode, builder safety, MDX workers, paths
npm run test:e2e     # Electron integration + security regressions
npm test             # both
```

`npm run test:e2e` passes `--no-sandbox` **to the test harness only**, because
the development Electron binary cannot sandbox itself (see above). If you have
made `chrome-sandbox` setuid, run the suite fully sandboxed:

```bash
GLOSS_TEST_SANDBOX=1 npm run test:e2e
```

To review the interface visually:

```bash
node scripts/screenshots.js   # writes test/screenshots/
```

---

## Project structure

```
pdf-reader-with-dictionary/
├── main.js                  # main-process entry: single instance, CLI args
├── preload.js               # context bridge
├── main/                    # main-process modules
├── renderer/
│   ├── index.html           # app shell
│   ├── style.css            # the whole design system
│   └── js/                  # renderer modules
├── about.html/.css/.js      # about window
├── assets/icon.png
├── build/                   # packaging scripts (deb maintainer scripts)
├── scripts/                 # glossary builder, fixtures, visual/perf tools
├── test/unit/               # node:test suites
├── test/e2e/                # Playwright + Electron suites
└── docs/                    # architecture and testing notes
```

---

## Tech stack

| Package | Version | Role |
|---|---|---|
| [Electron](https://www.electronjs.org/) | 45 | Desktop shell and process model |
| [PDF.js](https://mozilla.github.io/pdf.js/) | 6.5 | PDF parsing, rendering, text layer |
| [js-mdict](https://github.com/terasum/js-mdict) | 7 | MDX dictionary parsing |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 3.4 | Sanitizing untrusted dictionary HTML |
| [electron-builder](https://www.electron.build/) | 26 | AppImage and Debian packaging |
| [Playwright](https://playwright.dev/) | 1.65 | Electron integration tests |

No frontend framework and no bundler — plain ES modules in the renderer.

---

## Known limitations

- **Scanned PDFs have no text.** Gloss displays them and says so plainly, but
  search and lookup need text. There is no built-in OCR.
- **Some PDFs have broken text mappings.** A PDF can render perfectly while
  carrying incorrect `ToUnicode` data — Devanagari conjuncts are especially
  prone to this, and Chromium's own PDF export has the problem. Gloss detects
  the case and warns you instead of silently returning wrong words. Nothing can
  recover the correct text from such a file short of OCR.
- **pdf.js decides where text runs begin and end.** Occasionally it inserts a
  space inside a word or splits one across runs. Search handles the splits;
  the glossary builder recovers conservative Devanagari/hyphenated splits, but
  a spurious inserted space can still affect an exact-phrase search.
- **AppImage sandboxing on Ubuntu 24.04+** — see the packaging note above.
- **Linux x86_64 and Windows x64** supported in this release.

---

## License and authorship

Copyright © 2026 **Shardhay Vatshyayan** (`@shardhayv`). Gloss 2.1.1 and later
is free software licensed under the **GNU Affero General Public License v3.0
only** — see [LICENSE](LICENSE). This keeps the application compatible with the
AGPL-licensed `js-mdict` 7 runtime it distributes. Earlier revisions remain
available under the license stated in those revisions. The project copyright
and warranty notice is in [NOTICE](NOTICE).

Runtime and development dependencies retain their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Gloss bundles no dictionary data. Dictionaries and glossaries you load are
yours, and their contents are treated as untrusted input regardless of origin:
definitions are sanitized before display and can never navigate the app or
reach the network — including glossaries you wrote yourself.

<div align="center">

Built by **[Shardhay Vatshyayan](https://github.com/shardhayv)** — because
reading should be effortless.

</div>
