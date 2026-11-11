# Architecture

Notes on the decisions that are not obvious from reading the code, and the
constraints that keep them in place.

---

## Process split

| | Main process | Renderer |
|---|---|---|
| Runs | `main.js`, `main/*` | `renderer/js/*` |
| Node access | full | none (`sandbox: true`, `nodeIntegration: false`) |
| Owns | filesystem, dictionaries, network, window state | rendering, text, UI |
| Talks via | `ipcMain.handle` | `window.gloss` (contextBridge) |

MDX parsing is the exception to the two-column picture: `main/mdx-worker.js`
runs in a Node worker thread. `js-mdict` builds its index synchronously, so
doing that in the main process would freeze the window for a large dictionary.
The main process sends the complete candidate ladder in one worker message and
receives the first hit; JSON glossaries remain in-process because they are
small and cheap to parse.

Worker startup and lookup have hard timeouts. If an MDX worker crashes or stops
responding, its outstanding requests reject, the worker is retired, healthy
dictionaries still return results, and the popup identifies the unavailable
source with a Reload action instead of presenting the failure as “no word
found.”

The renderer has no filesystem or network capability of any kind. Everything it
can do is enumerated in `preload.js`, and `test/e2e/security.spec.js` asserts
that list exactly, so widening the surface fails a test.

### Why the renderer cannot name a file

There is no "read this path" IPC. A path becomes readable only after the main
process observes a user action that produced it:

- a file dialog it opened itself,
- a command-line argument or `second-instance` argv it parsed,
- an entry already in the recent-documents list,
- a dropped `File`, resolved to a path **in the preload** via
  `webUtils.getPathForFile`.

That last one matters: the page hands the preload a real `File` object, and the
preload — not the page — produces the path. A compromised renderer cannot
fabricate one, which `security.spec.js` verifies by trying.

`main/paths.js` then canonicalizes with `realpath`, opens a file handle, stats
and sniffs `%PDF-` through *that handle*, and reads from it. Validating the
handle rather than re-opening the path closes the window where a symlink could
be swapped between the check and the read.

---

## Dictionary content is hostile

MDX files are downloaded from the internet, so every definition is untrusted
HTML. Two independent locks:

1. **DOMPurify** with a strict allowlist (`renderer/js/popup.js`). No `script`,
   `style`, `svg`, `math`, `template`, `iframe`, `form`, or media elements; no
   `style` or `on*` attributes; only `https:` and `entry:` URLs survive.
2. **No live `href` ever reaches the DOM.** An `afterSanitizeAttributes` hook
   rewrites links to `data-external` / `data-entry` attributes handled by a
   delegated click listener. Even a total sanitizer bypass produces markup with
   nothing navigable in it.

Behind both, `main/security.js` denies `will-navigate`, `will-redirect`,
`will-frame-navigate`, `setWindowOpenHandler`, and all permission requests, and
`shell:openExternal` accepts only `http:`/`https:` after parsing the URL.

`test/e2e/security.spec.js` runs 25 payloads — unquoted handlers, `javascript:`,
`data:`, `file:`, `vbscript:`, mXSS via `noscript` and `math/mglyph`, remote
tracking images, `base href` — through the real pipeline and asserts nothing
executable, navigable, or network-reaching survives.

---

## Virtualized rendering

`renderer/js/viewer.js` creates a correctly sized placeholder for **every** page
immediately, so the scrollbar is accurate from the first frame, then renders
lazily:

- an `IntersectionObserver` with a 600 px root margin mounts pages within
  `RENDER_BUFFER` (2) of the viewport;
- pages further than `DESTROY_DISTANCE` (5) away are torn back down to
  placeholders, cancelling any in-flight `RenderTask`;
- canvases are capped at `MAX_CANVAS_PIXELS` (16 M device pixels) so a deep zoom
  on a large page cannot allocate an enormous bitmap.

Page painting and selectable-text construction are independent. If a malformed
text map breaks the text layer after the canvas painted, Gloss keeps the
visible page and disables selection only for that page. If painting itself
fails, the page shows a recoverable **Retry page** control instead of remaining
an unexplained white placeholder.

Measured on a 300-page fixture, live canvases stay in single digits no matter
how far you scroll; `reader.spec.js` asserts the bound.

### Stale work can never touch a new document

Every document gets a `generation` number. Each `await` boundary in
`renderPage`, `getPageText`, `openDocument`, and `renderThumbnail` re-checks it
and returns early if the document changed underneath. `closeDocument` bumps the
generation, cancels render tasks, disconnects observers, clears caches, revokes
thumbnail object URLs, and destroys the `PDFDocumentProxy` and its loading task.

### Zoom

Zoom applies instantly by rescaling the existing canvas with CSS and marking
pages stale, then re-renders visible pages at the new scale after a 140 ms
debounce. The result is a responsive zoom that never queues a render storm
during a wheel gesture. Scroll offsets are adjusted around an anchor point so
`Ctrl`+wheel keeps the point under the cursor fixed.

---

## Unicode

`renderer/js/text.js` is pure — no DOM, no Electron — so it is testable in plain
Node, which is where most of the Unicode risk lives.

### Segmentation

`Intl.Segmenter` with `granularity: 'grapheme'` for anything that must not split
(conjuncts, matras, nukta, chandrabindu, ZWJ/ZWNJ), and `'word'` for counting
words. Nothing uses `\w`, `[A-Za-z]`, or ASCII punctuation classes. Edge
trimming uses `\p{P}\p{S}\p{Z}\p{Cf}` and touches only the ends of a string, so
interior viramas and marks are never disturbed.

### The candidate ladder

MDX lookup is exact-match, so `lookupCandidates()` produces an ordered,
deduplicated list and `main/dicts.js` returns the first hit per dictionary:

1. the exact selected text,
2. its NFC form,
3. Unicode-aware edge-trimmed forms,
4. script-appropriate variants (ZWJ/ZWNJ stripped),
5. Latin case variants — **only** for Latin-script tokens.

Exact-first is what keeps `Paris` and `NASA` findable in dictionaries keyed on
proper case. Latin casing is never applied to Devanagari.

NFC deserves a note: Devanagari precomposed nukta forms (U+0958–U+095F) are
composition exclusions, so NFC *decomposes* them. `क़िला` and its NFC form are
genuinely different strings, and dictionaries use either — hence both rungs.

The original selection is never mutated. Candidates exist only for lookup;
copying always yields exactly what the document contained.

### Search

`buildSearchIndex()` normalizes per grapheme cluster and records, for every
normalized character index, both original cluster boundaries. Matches therefore
expand to whole clusters and map back exactly, even when normalization changes
length (`İ` → `i̇`, or a precomposed Devanagari nukta form decomposes). A query
can never become an empty highlight or match half a conjunct.

Page text uses geometry-aware boundaries rather than blindly joining or spacing
every pdf.js item. Real lines and columns receive a separator, while same-line
runs remain contiguous. A conservative recovery handles the fixture's unusual
`प्र` + `ज्ञा` split across two mapped lines, preserving `प्रज्ञा` without making
unrelated column text look like one phrase.

Search extracts pages independently. A malformed page is counted as unreadable
and skipped while the rest of the book remains searchable; the result counter
makes the partial scope explicit.

---

## Lookup orchestration

One user action produces exactly one lookup.

`selection.js` only ever acts on selections whose anchor *and* focus are inside
`.pdf-text-layer`, so text selected in the toolbar, preferences, popup, or empty
state can never trigger a lookup. A double-click delivers two `pointerup`
events, and reading a selection must be deferred until after `pointerup` — by
which time the second click has already selected the word, so both events would
see the same selection. A 150 ms trailing coalesce collapses the burst into one
lookup and also keeps the app quiet mid-drag.

`lookup.js` gives every lookup a monotonically increasing token and discards any
response that arrives after a newer lookup started, so a slow network call can
never overwrite a newer local result. The popup shows the query immediately with
a loading state, local results land first, and the online tiers fill in
afterwards.

### The three lookup tiers

Local dictionaries and glossaries answer first and offline. Beyond them sit two
independent online tiers, each with its own enable/fallback preference:

* **Wiktionary** (`main/wiktionary.js`) — the online *dictionary*: senses,
  part of speech, examples. This is the tier that answers "what does this word
  mean", which is what a reader almost always wants.
* **Wikipedia** (`main/wiki.js`) — the online *encyclopedia*: what a named
  thing is. Useful for proper nouns and concepts, wrong for ordinary words.

Both are requested with a single `Promise.all` rather than in sequence: they are
independent, and a reader waiting on a word should wait one round trip, not two.
Wiktionary is placed ahead of Wikipedia in the popup's source tabs.

Only the English Wiktionary is contacted. The `/page/definition/` REST endpoint
is implemented by that edition alone — hi, ne and mai answer `501` — and it
returns non-English headwords grouped by language code and glossed *in English*,
which is what a reader of a Devanagari text wants. The preferred-language
preference therefore orders the returned sections rather than choosing a host.

Definition bodies are Parsoid HTML. `main/wiktionary.js` normalizes them
(internal `/wiki/Foo` links become `entry://Foo` cross-references the popup can
follow, parser bookkeeping attributes and template `<style>` blocks are dropped,
senses and sections are capped so "run" cannot deliver 72 senses to a popup),
but it does not trust them: the renderer runs every definition through the same
DOMPurify pass as MDX dictionary HTML.

Nothing is ever handed to a search engine automatically. The popup's optional
**Search the web** link is inert markup until clicked, and then goes out through
the existing user-initiated `shell:openExternal` channel to the default browser.

### Link annotations

A page renders three independent layers: the canvas, the text layer, and — when
the page has Link annotations — a link overlay. Each is built in its own `try`,
so a page with broken annotations still paints and still selects.

Only `Link` annotations are honoured; widgets, forms and popup annotations are
deliberately not rendered. The overlay's anchors carry **no href**, exactly like
sanitized dictionary links, and the whole layer is `pointer-events: none` —
selection is Gloss's primary gesture and must never be swallowed by an invisible
box. `renderer/js/links.js` hit-tests the overlay rectangles on click instead,
using the live elements' bounding rects so any zoom transform is already
accounted for.

Because linked words are still words, a click on a link is held for 180 ms. If a
second click arrives (`detail > 1`), or a selection turns out to exist, the
lookup wins and the link is abandoned — double-clicking a linked word defines it
rather than launching a browser. External links leave through the same
user-initiated `shell:openExternal` channel as popup links; internal ones resolve
through `viewer.resolveDestination`, shared with the outline sidebar.

### Per-book glossary activation

A generated JSON glossary carries `scope: "book"` plus the source PDF's relative
path and PDF.js fingerprint. `main/glossary.js` answers only when either identity
matches the document confirmed as open by the renderer. This lets many book
glossaries stay loaded without returning a context-specific definition for the
wrong PDF or filling the toolbar with inactive sources. Source-less legacy JSON
and explicit `scope: "global"` files behave like general dictionaries.

Reload is transactional: the replacement JSON is parsed completely before the
working instance is closed. A malformed edit returns an error while the last
valid copy continues answering lookups.

---

## State

`main/store.js` owns two files under `app.getPath('userData')`:
`preferences.json` (settings, window bounds, dictionary list, saved vocabulary) and
`documents.json` (per-document page, zoom, rotation, spread mode, bookmarks, and scroll position; recents are
derived from it). Writes are debounced and atomic (`tmp` + `rename`), with a
synchronous flush on quit.

Unreadable state is never deleted silently: Gloss copies it to a timestamped
`.corrupt-*` file, starts from validated defaults, and tells the user. Runtime
write failures are surfaced in the window (with rate limiting) instead of
appearing only in a terminal log.

Renderer failures are recoverable too. If Chromium loses the renderer process
(for example after a GPU/driver or memory fault), `main.js` reloads the same
window, reopens its last confirmed PDF through the normal authorized pipeline,
and restores saved page/zoom/scroll state. Two automatic attempts are allowed
per minute; a repeated loop becomes an explicit Reload/Quit dialog.

Both files are inside the user's own trust boundary — a user who edits them can
only affect their own session — so validation there is defensive, not a security
control. It still runs: types are coerced, enums checked, numbers clamped,
arrays capped, and window bounds intersected against `screen.getDisplayMatching`
so a stale or hand-edited position cannot reopen the window off-screen.

Renderer writes go through an allowlist of twelve preference keys (`theme`,
`pageTone`, `sidebarOpen`, `sidebarTab`, `defaultZoom`, `autoLookup`,
`wiktionaryEnabled`, `wiktionaryFallbackOnly`, `wikipediaEnabled`,
`wikipediaFallbackOnly`, `wikipediaLang`, `savedWords`); everything else is
main-process-only.

---

## Keyboard layering

One `keydown` dispatcher in `app.js`. `Escape` consults an explicit
topmost-first stack — password prompt, document properties, preferences,
search, popup, read mode — and closes exactly one layer.

Zoom shortcuts match on `event.code` (`Digit0`, `Equal`, `Minus`), not
`event.key`, because the character produced by `Shift+0` and by `+`/`-` varies
by keyboard layout.

Menu items display their accelerators but are registered with
`registerAccelerator: false`. The renderer needs the focused element and the
active layer to decide what a key means, so it owns the keys; registering them
natively as well would fire both handlers and, for example, zoom twice per
keypress.
