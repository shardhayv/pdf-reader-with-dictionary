# Building an AI-assisted glossary for a book

Gloss reads two complementary local formats:

- **MDX dictionaries** are broad reference dictionaries you already have or
  download. They work for every PDF. Gloss parses each MDX in a worker thread,
  so loading a large file does not freeze the reader.
- **JSON glossaries** are small dictionaries you or an AI build. The normal
  case is one glossary per PDF, automatically enabled only while that book is
  open. A JSON glossary can also be explicitly global.

Both formats use the same priority list, enable/disable controls, Unicode
candidate ladder, definition popup, and HTML sanitizer. They work offline.

## Fast workflow

Run these commands from a source checkout of Gloss:

```bash
npm run glossary -- ~/Books/book.pdf --list
npm run glossary -- ~/Books/book.pdf --language hi
```

The first command previews candidates and writes nothing. The second creates
`~/Books/book.glossary.json` with contextual occurrences and blank definitions.

Then:

1. Give the JSON draft to an AI and ask it to fill only `definition` and, where
   useful, `aliases`. Tell it to preserve all other fields and valid JSON.
2. Review a batch of definitions. You do not need to finish the file: entries
   with blank definitions remain dormant.
3. In Gloss, open **Preferences → Dictionaries → Add dictionaries…** and choose
   the JSON file.
4. If you edit it while reading, click its **Reload** button. A bad edit never
   replaces the last working in-memory copy.

You can regenerate the draft later. Gloss merges it instead of overwriting it:
completed definitions, aliases, manual entries, custom fields, and your chosen
examples survive; new vocabulary and extraction counts are added. The previous
JSON is copied to `.bak`, and the replacement uses an atomic rename.

## Format

The builder writes the versioned form below:

```json
{
  "format": "gloss-glossary",
  "version": 1,
  "name": "Midnight's Children — glossary",
  "language": "en",
  "scope": "book",
  "source": {
    "file": "Midnights Children.pdf",
    "fingerprint": "pdfjs-document-fingerprint",
    "pages": 647
  },
  "entries": [
    {
      "word": "chutnification",
      "aliases": ["chutnified", "chutnify"],
      "definition": "Rushdie's coinage for preserving and transforming memory, compared with making chutney.",
      "count": 4,
      "page": 531,
      "example": "…the chutnification of history…",
      "occurrences": [
        { "page": 531, "text": "…the chutnification of history…" }
      ]
    },
    {
      "word": "काठमाडौँ",
      "aliases": ["काठमाडौं"],
      "definition": "नेपालको राजधानी र सबैभन्दा ठूलो सहर।",
      "count": 7,
      "page": 12,
      "example": "उनी काठमाडौँ फर्किए।"
    }
  ]
}
```

Entry fields:

| Field | Use |
|---|---|
| `word` | Required headword, preserved exactly as authored |
| `definition` | Plain text or a small HTML fragment; blank means draft |
| `aliases` | Inflections, alternate spellings, or equivalent Unicode forms |
| `example` | Preferred contextual sentence shown in the popup |
| `occurrences` | Up to three generated page/sentence examples for authoring |
| `count` | Number of appearances found in the book |
| `page` | First page on which the builder found the term |

`language` is optional. A valid tag such as `en`, `hi`, `ne`, or `sa` helps
screen readers pronounce definitions. Definitions are sanitized at display
time exactly like MDX content; scripts, remote images, and live links do not
become active.

The reader remains compatible with the initial simple format (`source` as a
string, one `example`, one `page`) and with a bare array of entries.

## Book-scoped versus global

Generated glossaries use `"scope": "book"`. Gloss compares the open PDF with
both `source.file` and its PDF fingerprint, so the glossary still activates if
the book and glossary move together or the PDF is renamed. Other books'
glossaries remain loaded but neither answer lookups nor clutter the toolbar.

For a reusable AI-built dictionary, write:

```json
{
  "format": "gloss-glossary",
  "version": 1,
  "name": "My English and Devanagari dictionary",
  "scope": "global",
  "entries": [
    { "word": "liminal", "definition": "At a boundary or transitional stage." },
    { "word": "प्रज्ञा", "definition": "गहिरो ज्ञान, विवेक वा बोध।" }
  ]
}
```

A source-less legacy JSON glossary is also treated as global.

## Candidate quality

The builder uses different defaults for the two primary scripts:

- Latin: at least 4 grapheme clusters;
- Devanagari: at least 2 grapheme clusters, so `प्रज्ञा`, `क्षेत्र`, `हिन्दी`,
  and `संस्कृत` are not discarded;
- other scripts: at least 4 grapheme clusters.

It uses `Intl.Segmenter`, counts combining marks and joiners as word content,
keeps conjuncts intact, recovers conservative Devanagari text-run splits, and
repairs the narrow case where a PDF inserts a synthetic space after nukta or
virama (`क़ लम` becomes `क़लम`) without joining ordinary phrases such as
`की किताब`. It retains hyphenated/apostrophized terms such as `state-of-the-art` and
`दुःख-दर्शन`. A recurring unfamiliar term ranks ahead of a one-off candidate;
there is no default “rare words only” ceiling.

The built-in `scripts/data/common-words.txt` removes ordinary English and
Devanagari vocabulary. Add words you already know to that file, or pass a
personal list with `--exclude FILE`.

The builder refuses to write a draft when a PDF is scanned or its text mapping
is badly corrupted. That is intentional: a confident-looking glossary made
from NULs or scrambled glyphs is worse than an explicit request to OCR the PDF.

## Options

```text
--list                         preview only
-o, --output FILE              choose the JSON path
--name NAME                    label shown in Gloss
--language TAG                 en, hi, ne, sa, or another BCP-47 tag
--min-latin-length N           default 4 graphemes
--min-devanagari-length N      default 2 graphemes
--min-length N                 set both primary-script minimums
--max-count N                  optional rare-only ceiling; disabled by default
--limit N                      maximum candidates after ranking; default 5000
--no-names                     remove capitalized Latin names (useful for manuals)
--exclude FILE                 add known words, one per line
--keep-common                  disable the built-in known-word filter
--force-garbled                diagnostic override for a broken text map
```

Use `--force-garbled` only to inspect extraction. Do not ask an AI to define a
corrupted list.

## Safe regeneration and recovery

The builder refuses to:

- write over the PDF itself, including a hard-link alias;
- replace invalid existing JSON;
- merge into a glossary whose PDF fingerprint or legacy source path belongs to
  another book;
- produce output when extraction has no useful candidates.

When updating `book.glossary.json`, the immediately previous file is retained
as `book.glossary.json.bak`. If an editor or AI produces malformed JSON while
Gloss is open, Reload reports the error and keeps the previous parsed glossary
active. Repair the file and reload again.
