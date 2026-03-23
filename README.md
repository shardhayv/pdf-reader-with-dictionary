<div align="center">

# Gloss

**A distraction-free PDF reader with instant dictionary lookup**

*Double-click any word. Get a definition. Never leave the page.*

![Electron](https://img.shields.io/badge/Electron-33-47848F?style=flat&logo=electron&logoColor=white)
![PDF.js](https://img.shields.io/badge/PDF.js-v4-orange?style=flat)
![Platform](https://img.shields.io/badge/Platform-Windows-0078D6?style=flat&logo=windows&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green?style=flat)

</div>

---

## What is Gloss?

Gloss is a desktop PDF reader built around a single idea: when you don't know a word, looking it up should take one gesture, not ten. Double-click any word in the PDF and a definition appears inline — sourced from your own MDX dictionaries (Oxford, Merriam-Webster, etc.) with Wikipedia as a fallback.

Built entirely with web technologies inside Electron, with no frontend framework — just well-structured vanilla JS, PDF.js v4, and a strict two-process security model.

---

## Features

| | |
|---|---|
| **Instant word lookup** | Double-click any word in the PDF to get a definition immediately |
| **Multi-dictionary support** | Load multiple `.mdx` dictionaries, set lookup priority, toggle them on/off |
| **Wikipedia fallback** | Automatically queries Wikipedia when no dictionary match is found |
| **Virtual page rendering** | Only renders pages near the viewport — 500-page PDFs open instantly |
| **Continuous scroll** | Smooth infinite-scroll layout, the way reading on the web works |
| **Read mode** | F11 hides all UI chrome — nothing but the document |
| **Theme support** | Light, dark, or follows system preference |
| **HiDPI rendering** | Canvas renders at `devicePixelRatio` for sharp text on high-DPI displays |
| **Go-to-page** | Type a page number and press Enter to jump instantly |
| **Preferences** | Persistent settings across sessions — dictionary order, Wikipedia mode, theme |

---

## Architecture

Gloss follows Electron's recommended two-process model with strict context isolation.

```
┌─────────────────────────────────────────────────────────┐
│  Main Process (main.js)                                 │
│  Node.js · file system · dialog · IPC handlers         │
│  Dictionary state · Wikipedia HTTP · preferences        │
└──────────────────────┬──────────────────────────────────┘
                       │ contextBridge (ipcRenderer.invoke)
┌──────────────────────▼──────────────────────────────────┐
│  Preload (preload.js)                                   │
│  Exposes window.electronAPI — 17 typed methods          │
└──────────────────────┬──────────────────────────────────┘
                       │ window.electronAPI.*
┌──────────────────────▼──────────────────────────────────┐
│  Renderer Process (renderer/renderer.js)                │
│  PDF rendering · UI · word lookup · popup · observers  │
└─────────────────────────────────────────────────────────┘
```

- `nodeIntegration: false` and `contextIsolation: true` are enforced — the renderer has zero direct Node access
- All file I/O, dictionary parsing, and network calls happen exclusively in the main process
- The renderer communicates only through the typed API exposed by the preload bridge

---

## How the Key Features Work

### Virtual / lazy rendering

Rendering every page of a large PDF upfront is the most common crash vector in PDF viewers. Gloss avoids this entirely:

1. On load, placeholder `<div>`s are created for **all pages immediately** — sized to the correct height so the scrollbar is accurate from the start
2. An `IntersectionObserver` watches every placeholder with a `200px` root margin
3. When a placeholder enters (or nears) the viewport, its canvas and text layer are rendered on demand
4. Pages more than 5 away from the current viewport have their canvas **destroyed** and replaced back with a placeholder — freeing GPU and heap memory
5. Result: only 4–5 pages live in memory at any time, regardless of document length

### Word lookup pipeline

```
dblclick on .pdf-text-layer
  → extractCleanWord()          strip punctuation, normalise case
  → lookupCache.get(word)       return immediately if cached
  → electronAPI.lookupAll()     query all enabled MDX dicts in priority order
  → electronAPI.lookupWikipedia() if enabled and conditions met
  → showPopup()                 position relative to selection rect
```

Results are cached in a `Map` for the session so repeated lookups are instant.

### Text layer

PDF.js v4 renders an invisible `<div>` of absolutely-positioned `<span>`s over the canvas, matching the exact position and scale of every word in the document. This enables native text selection and the `dblclick` event that drives the lookup — the canvas itself is not interactive.

---

## Project Structure

```
electron-pdf-reader/
├── main.js              # Main process — IPC, file I/O, dictionary state
├── preload.js           # Context bridge — exposes window.electronAPI
├── about.html           # About window
├── renderer/
│   ├── index.html       # App shell
│   ├── renderer.js      # All UI logic, PDF rendering, word lookup
│   └── style.css        # Theming, layout, popup, modal
└── package.json
```

---

## Getting Started

**Prerequisites:** Node.js v18+

```bash
git clone https://github.com/shardhayv/pdf-reader-with-dictionary.git
cd gloss
npm install
npm start
```

**Build a Windows installer:**

```bash
npm run build
# Output → dist/
```

---

## Usage

1. **Open PDF** — click *Open PDF* in the toolbar
2. **Add a dictionary** — click *Add Dictionary* and select an `.mdx` file
   > Free MDX dictionaries (Oxford, Merriam-Webster, WordNet, OALD, etc.) are widely available online
3. **Look up a word** — double-click any word in the document
4. **Navigate** — scroll freely, or type a page number in the toolbar and press Enter
5. **Read mode** — press `F11` to strip the UI and read full-screen
6. **About** — `Help → About Gloss` or press `F1`

---

## Tech Stack

| Package | Version | Role |
|---|---|---|
| [Electron](https://www.electronjs.org/) | 33 | Desktop shell, main/renderer process model |
| [PDF.js](https://mozilla.github.io/pdf.js/) | 4.9 | PDF parsing, canvas render, text layer |
| [js-mdict](https://github.com/terasum/js-mdict) | 7 | MDX/MDict dictionary file parsing |
| [electron-builder](https://www.electron.build/) | 25 | Windows NSIS installer packaging |

No frontend framework. No bundler. Plain ES modules in the renderer.

---

## License

MIT

---

<div align="center">

Built by **Shardhay Vatshyayan** — because reading should be effortless.

</div>
