<div align="center">

# Gloss

**A quiet PDF reader for people who read to understand**

*Select a word — in English or Devanagari — and its meaning appears in the margin.*

![Electron](https://img.shields.io/badge/Electron-33-47848F?style=flat&logo=electron&logoColor=white)
![PDF.js](https://img.shields.io/badge/PDF.js-4.10-orange?style=flat)
![Platform](https://img.shields.io/badge/Platform-Linux%20x86__64-E95420?style=flat&logo=linux&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green?style=flat)

</div>

---

## What Gloss is

Gloss is a desktop PDF reader built around one idea: when you don't know a word,
looking it up should take one gesture, not ten. Select any word and a definition
appears next to it — from **your own MDX dictionaries**, with Wikipedia as an
optional fallback. For each book, Gloss can also use a small **AI-assisted JSON
glossary** containing the names, coined words, and context-specific meanings
that no general dictionary knows.

It works equally well with Latin and Devanagari text. Selecting `काठमाडौँ` gives
you the whole word, chandrabindu and all; searching for `क्षेत्र` finds it even
when the conjunct is split across two internal text runs.

Dictionary lookups are entirely local. Wikipedia is the only network request
Gloss ever makes, and only when you ask for a word. There are no accounts, no
telemetry, and no analytics.

---

## Features

| | |
|---|---|
| **Instant lookup** | Select a word or short phrase; the definition appears without covering the line you're reading |
| **Latin and Devanagari** | Unicode-aware selection, search, and lookup that never split a conjunct or drop a matra |
| **Your dictionaries** | Load any number of `.mdx` files without freezing the reader, set their priority, toggle them per lookup |
| **Per-book glossaries** | Build an AI-assisted JSON glossary for one PDF; it activates automatically only for that book |
| **Wikipedia fallback** | Optional, in English, Hindi, Nepali, or Maithili |
| **Big documents** | Only a handful of pages are ever in memory, so a 300-page PDF opens instantly |
| **Find in document** | Unicode-aware search with result counts and highlighting |
| **Pages and outline** | Lazy thumbnail sidebar and the document's own table of contents |
| **Zoom** | Fit width, fit page, and free zoom with `Ctrl`+wheel anchored under the cursor |
| **Picks up where you left off** | Page, zoom, and scroll position are remembered per document |
| **Reads like a native app** | Drag-and-drop, file associations, recent documents, remembered window position |
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

## Packaging

```bash
npm run dist            # AppImage + .deb into dist/
npm run dist:deb        # .deb only  (recommended on Debian/Ubuntu)
npm run dist:appimage   # AppImage only
npm run dist:dir        # unpacked build into dist/linux-unpacked/
```

Install and run the `.deb`:

```bash
sudo apt install ./dist/gloss_2.1.0_amd64.deb
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
   pick one or more `.mdx` files. Free MDX dictionaries (Oxford, Merriam-Webster,
   WordNet, and Hindi/Nepali dictionaries) are widely available; Gloss does not
   bundle any.

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
| `Ctrl` `+` / `-` | Zoom in / out |
| `Ctrl+0` | Fit width |
| `Ctrl+Shift+0` | Fit page |
| `Ctrl` + mouse wheel | Zoom around the cursor |
| `F9` | Pages and outline sidebar |
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
│  wiki.js      the only network access in the app             │
│  security.js  navigation, window, and permission denial      │
│  windows.js   window lifecycle, bounds, menu                 │
│  ipc.js       the entire IPC surface                         │
└───────────────────────────┬──────────────────────────────────┘
                            │ contextBridge — 24 typed methods
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
| [Electron](https://www.electronjs.org/) | 33 | Desktop shell and process model |
| [PDF.js](https://mozilla.github.io/pdf.js/) | 4.10 | PDF parsing, rendering, text layer |
| [js-mdict](https://github.com/terasum/js-mdict) | 7 | MDX dictionary parsing |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 3 | Sanitizing untrusted dictionary HTML |
| [electron-builder](https://www.electron.build/) | 25 | AppImage and Debian packaging |
| [Playwright](https://playwright.dev/) | 1.62 | Electron integration tests |

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
- **Linux x86_64 only** in this release. Nothing in the code is Linux-specific,
  but no other platform has been built or tested.

---

## License

MIT — see [LICENSE](LICENSE).

Gloss bundles no dictionary data. Dictionaries and glossaries you load are
yours, and their contents are treated as untrusted input regardless of origin:
definitions are sanitized before display and can never navigate the app or
reach the network — including glossaries you wrote yourself.

<div align="center">

Built by **Shardhay Vatshyayan** — because reading should be effortless.

</div>
