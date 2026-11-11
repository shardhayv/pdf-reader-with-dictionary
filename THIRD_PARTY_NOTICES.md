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

The source repository contains no third-party dictionary data. The **release
packages** (`.deb`, Windows installer, portable `.exe`) include four offline
JSON dictionaries, about 315,000 entries, installed under
`resources/dictionaries` with a `NOTICES.txt` carrying the notices below.
They are separate works from the program — Gloss's AGPL-3.0 licence covers
the application, not this data.

| File | Built from | Terms |
|---|---|---|
| `10` General English | Princeton WordNet 3.0 (via the NLTK `wordnet` corpus package), plus everyday words and computing terms written for Gloss (`scripts/data/`) | **WordNet licence** — © Princeton University; full text in `build/DICTIONARY-NOTICES.txt`. Gloss-written entries: the repository's licence |
| `11` Devanagari — Sanskrit | [`vkadal/sanskrit-english-dictionary`](https://github.com/vkadal/sanskrit-english-dictionary) (Cologne lexicon editions of Apte, Macdonell, Monier-Williams) | **MIT** |
| `12` Devanagari — Nepali Shabdakosh | [`Shubhamnpk/yoshabdakosh`](https://github.com/Shubhamnpk/yoshabdakosh) | **MIT** |
| `13` Banking & Finance Abbreviations | Written for Gloss (`scripts/data/banking-abbreviations.tsv`) | the repository's licence |

**Release packages contain no Creative Commons-licensed text and no
unlicensed data.** That is a rule of this project: packaging uses
`npm run dictionaries:bundle`, which runs the builder with `--public`.

### The full shelf, for personal use

`npm run dictionaries` (without `--public`) builds a larger set on your own
machine — nine subject dictionaries, Hindi, and English glosses for Nepali —
that draws on sources which are *not* redistributed with Gloss:

| Source | Terms |
|---|---|
| English Wikipedia "Glossary of …" articles and the list of computing abbreviations | CC BY-SA 4.0, © its contributors |
| English Wiktionary entries for Hindi and Nepali, via the [kaikki.org](https://kaikki.org) extracts | CC BY-SA 4.0 and GFDL, © its contributors |
| [`bdrillard/english-hindi-dictionary`](https://github.com/bdrillard/english-hindi-dictionary) | **no licence is published** in that repository (checked 2026-11-11) |

The script downloads these directly from their publishers to your computer.
Using them yourself is one thing; redistributing them means meeting the
ShareAlike and attribution terms, and for the unlicensed list, having no
stated permission at all. Do not put that set in `bundled-dictionaries/`.

Gloss 2.4.0's Windows packages predate this rule and included the Wikipedia-
derived dictionaries and the unlicensed Hindi list.

A reader can remove any bundled dictionary in **Preferences → Dictionaries**;
a removed dictionary stays removed. MDX files and glossaries a reader adds
themselves are never redistributed by Gloss and remain governed by their
owners' terms. Test PDFs are generated locally by the repository's fixture
scripts and are excluded from Git.

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
