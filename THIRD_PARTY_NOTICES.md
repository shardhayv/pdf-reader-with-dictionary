# Third-party notices

Gloss is created and maintained by **Shardhay Vatshyayan** and is licensed
under the GNU Affero General Public License v3.0 only. Its runtime is built on
the following open-source projects, which retain their own copyrights and
licenses.

| Component | Version in Gloss 2.5.0 | License | Project |
|---|---:|---|---|
| js-mdict | 7.0.0 | AGPL-3.0 | <https://github.com/terasum/js-mdict> |
| DOMPurify | 3.4.17 | MPL-2.0 OR Apache-2.0 | <https://github.com/cure53/DOMPurify> |
| PDF.js (`pdfjs-dist`) | 6.5.438 | Apache-2.0 | <https://github.com/mozilla/pdf.js> |
| Electron | 45.3.0 | MIT | <https://github.com/electron/electron> |

The source checkout also uses build and test tooling, including
electron-builder (MIT), Playwright (Apache-2.0), ESLint (MIT), and their
transitive dependencies. Exact versions and package-declared licenses are
recorded in `package-lock.json` and the installed packages' license files.

Electron packages include Electron and Chromium license notices in the built
application. Gloss does not modify or claim ownership of these dependencies.

## Dictionary content

The source repository contains no dictionary data. The **release packages**
(`.deb`, Windows installer, portable `.exe`) do: twelve offline JSON
dictionaries, about 361,000 entries, installed under `resources/dictionaries`
together with a `NOTICES.txt` carrying the notices below. They are built by
`scripts/download-dictionaries.py` and are separate works from the program —
Gloss's AGPL-3.0 licence covers the application, not this data.

| Files | Built from | Terms |
|---|---|---|
| `01`–`09` subject dictionaries | English Wikipedia "Glossary of …" and list articles, plus subject-filtered WordNet entries | Wikipedia text: **CC BY-SA 4.0**, © its contributors (shortened and reformatted; these files are offered under CC BY-SA 4.0 in turn) |
| `10` General English | Princeton WordNet 3.0, via the NLTK `wordnet` corpus package | **WordNet licence** — © Princeton University; full text in `build/DICTIONARY-NOTICES.txt` |
| `11` Devanagari — Hindi & Sanskrit | [`vkadal/sanskrit-english-dictionary`](https://github.com/vkadal/sanskrit-english-dictionary) (Cologne lexicon editions of Apte, Macdonell, Monier-Williams) and [`bdrillard/english-hindi-dictionary`](https://github.com/bdrillard/english-hindi-dictionary) | Sanskrit: **MIT**. Hindi: **no licence is published** in the source repository — see the note below |
| `12` Devanagari — Nepali Shabdakosh | [`Shubhamnpk/yoshabdakosh`](https://github.com/Shubhamnpk/yoshabdakosh) | **MIT** |

> **Unlicensed source.** `bdrillard/english-hindi-dictionary` carries no
> licence file (checked 2026-11-11), so its author has not stated the terms
> under which the word list may be redistributed. It is included with
> attribution. Anyone redistributing Gloss packages should make their own
> judgement, and can rebuild dictionary 11 without it or leave it out of a
> build by removing the file from `bundled-dictionaries/` before packaging.

A reader can remove any of them in **Preferences → Dictionaries**; a removed
dictionary stays removed.

MDX files and glossaries a reader adds themselves are never redistributed by
Gloss and remain governed by their owners' terms. Test PDFs are generated
locally by the repository's fixture scripts and are excluded from Git.

## Wikimedia content

When the online tiers are enabled, Gloss fetches article summaries from
Wikipedia and definitions from Wiktionary through the Wikimedia REST API, at
lookup time only. That text is contributed by Wikimedia's editors and is
licensed **CC BY-SA 4.0** (Wiktionary definitions are additionally available
under the GFDL):

- <https://en.wiktionary.org> — <https://creativecommons.org/licenses/by-sa/4.0/>
- <https://www.wikipedia.org> — <https://creativecommons.org/licenses/by-sa/4.0/>

Nothing is cached to disk, and every result is shown alongside a link back to
the source page it came from, which is where attribution and revision history
live. Gloss claims no ownership of this content.
