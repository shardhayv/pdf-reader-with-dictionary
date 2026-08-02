#!/usr/bin/env node
'use strict';

const HELP = `Build or safely update a per-book Gloss JSON glossary.

Usage:
  npm run glossary -- BOOK.pdf [options]

Options:
  --list                         Preview candidates; write nothing
  -o, --output FILE              Output path (default: BOOK.glossary.json)
  --name NAME                    Glossary label shown in Gloss
  --language TAG                 en, hi, ne, sa, or another BCP-47 tag
  --min-latin-length N           Latin minimum (default: 4 graphemes)
  --min-devanagari-length N      Devanagari minimum (default: 2 graphemes)
  --min-length N                 Set both script minimums
  --max-count N                  Optional rare-only ceiling; no default ceiling
  --limit N                      Maximum candidates after usefulness ranking (5000)
  --no-names                     Exclude capitalized Latin proper names
  --exclude FILE                 Add known words, one per line
  --keep-common                  Do not apply the built-in known-word list
  --force-garbled                Continue despite broken PDF text mappings
  -h, --help                     Show this help

Existing output is merged atomically: definitions, aliases, custom fields, and
manual entries are preserved; new candidates are added; a .bak copy is kept.`;

function takeValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} needs a value`);
  return value;
}

function numberValue(raw, option) {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${option} needs a number`);
  return value;
}

function parseArgs(argv) {
  const options = {};
  let input = '';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { help: true, input, options };
    if (arg === '--list') options.listOnly = true;
    else if (arg === '--no-names') options.dropNames = true;
    else if (arg === '--keep-common') options.keepCommon = true;
    else if (arg === '--force-garbled') options.forceGarbled = true;
    else if (arg === '-o' || arg === '--output') options.output = takeValue(argv, i++, arg);
    else if (arg === '--name') options.name = takeValue(argv, i++, arg);
    else if (arg === '--language') options.language = takeValue(argv, i++, arg);
    else if (arg === '--exclude') options.exclude = takeValue(argv, i++, arg);
    else if (arg === '--min-length') {
      const value = numberValue(takeValue(argv, i++, arg), arg);
      options.minLatinLength = value;
      options.minDevanagariLength = value;
    } else if (arg === '--min-latin-length') {
      options.minLatinLength = numberValue(takeValue(argv, i++, arg), arg);
    } else if (arg === '--min-devanagari-length') {
      options.minDevanagariLength = numberValue(takeValue(argv, i++, arg), arg);
    } else if (arg === '--max-count') {
      options.maxCount = numberValue(takeValue(argv, i++, arg), arg);
    } else if (arg === '--limit') {
      options.limit = numberValue(takeValue(argv, i++, arg), arg);
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else if (input) {
      throw new Error(`only one PDF can be processed at a time (unexpected: ${arg})`);
    } else {
      input = arg;
    }
  }
  return { help: false, input, options };
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`glossary: ${err.message}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  if (parsed.help) {
    console.log(HELP);
    return;
  }
  if (!parsed.input) {
    console.error(HELP);
    process.exitCode = 2;
    return;
  }

  try {
    const { buildGlossary } = await import('./glossary-builder.mjs');
    const result = await buildGlossary(parsed.input, parsed.options);
    console.log(`${require('node:path').basename(result.input)}: ${result.extracted.totalPages} pages, ` +
      `${result.distinctWords} distinct words, ${result.candidates.length} candidates`);
    if (parsed.options.listOnly) {
      for (const entry of result.candidates) {
        const recovered = entry.boundaryRecovered ? ' · recovered boundary' : '';
        console.log(`  p${entry.page}  ${entry.word}  (${entry.count}×${recovered})`);
      }
      return;
    }

    if (result.existed) {
      const merge = result.glossary.merge;
      console.log(`updated ${result.output}`);
      console.log(`preserved ${merge.preservedDefinitions} definitions; added ${merge.addedEntries} new entries`);
      if (result.backupPath) console.log(`previous file: ${result.backupPath}`);
    } else {
      console.log(`wrote ${result.output}`);
    }
    console.log('Fill definitions, add the JSON file in Gloss, then use Reload after later edits.');
  } catch (err) {
    console.error(`glossary build failed: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
