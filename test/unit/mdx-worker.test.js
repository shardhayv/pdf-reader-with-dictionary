/** MDX parsing/lookup stays off Electron's main thread and fails recoverably. */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MdxWorkerClient } = require('../../main/mdx-worker-client.js');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-mdx-worker-'));
  const modulePath = path.join(dir, 'fake-mdict.cjs');
  const dictionaryPath = path.join(dir, 'dictionary.mdx');
  fs.writeFileSync(modulePath, `
    'use strict';
    const fs = require('node:fs');
    class MDX {
      constructor(file) {
        const config = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (config.fail) throw new Error(config.fail);
        const until = Date.now() + (config.delay || 0);
        while (Date.now() < until) { /* deliberately synchronous parser */ }
        this.entries = config.entries || {};
      }
      lookup(word) {
        if (word === '__crash__') process.exit(7);
        if (word === '__hang__') while (true) { /* simulate a stuck parser */ }
        return Object.hasOwn(this.entries, word)
          ? { keyText: word, definition: this.entries[word] }
          : { keyText: word, definition: null };
      }
      close() {}
    }
    module.exports = { MDX };
  `);
  return { dir, modulePath, dictionaryPath };
}

test('synchronous MDX construction cannot block the main event loop', async () => {
  const { modulePath, dictionaryPath } = fixture();
  fs.writeFileSync(dictionaryPath, JSON.stringify({
    delay: 180,
    entries: { Paris: 'proper-case hit', 'प्रज्ञा': 'wisdom' },
  }));

  let timerRan = false;
  setTimeout(() => { timerRan = true; }, 20);
  const dictionary = await MdxWorkerClient.open(dictionaryPath, { modulePath });
  assert.equal(timerRan, true, 'MDX construction blocked the calling event loop');

  assert.deepEqual(await dictionary.lookupCandidates(['Paris', 'paris']), {
    keyText: 'Paris', definition: 'proper-case hit', matchedCandidate: 'Paris',
  });
  assert.equal((await dictionary.lookupCandidates(['प्रज्ञा'])).definition, 'wisdom');
  assert.equal(await dictionary.lookupCandidates(['missing']), null);
  dictionary.close();
});

test('a parser error rejects cleanly instead of crashing the app process', async () => {
  const { modulePath, dictionaryPath } = fixture();
  fs.writeFileSync(dictionaryPath, JSON.stringify({ fail: 'unsupported or damaged MDX' }));
  await assert.rejects(
    MdxWorkerClient.open(dictionaryPath, { modulePath }),
    /unsupported or damaged MDX/,
  );
});

test('a worker crash rejects the lookup and leaves the caller alive', async () => {
  const { modulePath, dictionaryPath } = fixture();
  fs.writeFileSync(dictionaryPath, JSON.stringify({ entries: {} }));
  const dictionary = await MdxWorkerClient.open(dictionaryPath, { modulePath });
  await assert.rejects(dictionary.lookupCandidates(['__crash__']), /stopped unexpectedly|closed/i);
  assert.equal(dictionary.closed, true);
});

test('a timed-out lookup retires the stuck worker instead of leaking it', async () => {
  const { modulePath, dictionaryPath } = fixture();
  fs.writeFileSync(dictionaryPath, JSON.stringify({ entries: {} }));
  const dictionary = await MdxWorkerClient.open(dictionaryPath, {
    modulePath,
    lookupTimeout: 50,
  });

  await assert.rejects(dictionary.lookupCandidates(['__hang__']), /timed out/i);
  assert.equal(dictionary.closed, true);
  await assert.rejects(dictionary.lookupCandidates(['anything']), /not running/i);
});
