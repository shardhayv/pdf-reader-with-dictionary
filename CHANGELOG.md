# Changelog

## 2.5.0 — 2026-11-11

A reliability and layout release. Every item below was reproduced in the
running app before it was fixed, and each has a regression test.

### Fixed

- **The toolbar no longer runs off the window.** With the twelve bundled
  dictionaries, 2.4.0 drew one chip per source: the toolbar was about
  2,500 px wide, the chips were cut off, and the Preferences button was
  unreachable at any window width above 860 px. The page counter also wrapped
  onto two lines ("of" / "42").
- **Opening a PDF from Explorer on Windows.** A drive path such as
  `C:\Books\a.pdf` was read as a URL with the scheme `C:` and rejected, so
  double-clicking a PDF, "Open with", and command-line arguments all opened
  Gloss with nothing loaded.
- **Copy did nothing.** Copy definition, Copy file path and the vocabulary
  export all failed silently: the clipboard-write permission was denied along
  with everything else.
- **Print.** Printing sent the on-screen DOM to the printer — four real pages
  of a 300-page book, then numbered blanks, each split across two sheets.
  Every page is now rendered at 150 dpi, one per sheet, with a progress dialog
  that can be cancelled.
- **Zoom lost your place.** Deep in a long document each zoom step, and each
  window resize in a fit mode, shifted the view by hundreds of pixels.
- **Zoomed pages were cut off.** Past fit-width, the left part of the page
  could not be scrolled to.
- **Keys went to the wrong place.** Space scrolled the document instead of
  pressing the focused button; arrow keys in the zoom menu turned pages; and
  shortcuts reached the document through open dialogs (`R` rotated the page
  behind Preferences).
- **Removed dictionaries came back.** Removing every bundled dictionary
  re-added all twelve on the next launch. In the portable build, dictionaries
  switched off were switched back on at every start.
- **Saved words** recorded `&amp;` in the source name and prefixed the
  definition with the upper-cased source badge.
- **The definition popup covered the word it explained** in a short window.
  It now goes beside the word, or takes the roomier side with its height
  capped, and never overlaps the selection.
- The general English dictionary was labelled "WordNet 3.1"; the data it is
  built from is WordNet 3.0. The label, script and notices now say so.
- The page number froze when zoomed far into a very large page.
- A saved dictionary whose file had gone missing was dropped without a word;
  it is now reported.
- The floating sidebar covered the find bar and document notice.
- The empty state lost its heading above the top of a short window.

### Changed

- **Sources** — one toolbar button with a count, opening a checklist grouped
  as *This book*, *Dictionaries* and *Online*, replaces the row of chips.
- **The toolbar adapts to any width**, folding tools into a **More** menu in
  priority order. The minimum window is now 420 × 360 (was 680 × 480).
- The reading position is saved as a page and an offset within it, so a
  document reopens on the same line even in a window of a different size.
- On narrow windows the sidebar floats over the page, and Preferences stacks
  its section list above the content.
- Dialogs make the window behind them inert and return focus when they close.
- `←` / `→` turn a whole spread in two-page view; `Shift+Space` scrolls up;
  `↑` / `↓` scroll wherever focus is.
- Back and Forward appear together and disable individually, so the toolbar
  does not reshuffle on every jump.
- Devanagari falls back to Nirmala UI / Mangal on Windows.

### Documentation

- README, architecture and testing notes corrected: Windows is a supported
  platform, release packages do bundle dictionary data, and the preference
  allowlist is listed as implemented.
- `THIRD_PARTY_NOTICES.md` now states where the bundled dictionaries come
  from and under what terms, and the same notice ships beside them.

## 2.4.0 — 2026-11-11

Two-page book spread, saved vocabulary and page bookmarks, twelve bundled
offline dictionaries, and Windows installer and portable builds.

## 2.3.0

Page rotation, paper tints, reading history, document properties, Electron 45
and PDF.js 6.5.
