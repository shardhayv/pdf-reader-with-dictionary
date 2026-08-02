/** Persistent state falls back safely and preserves unreadable input. */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-store-'));
require.cache[require.resolve('electron')] = {
  id: 'electron', filename: 'electron', loaded: true,
  exports: { app: { getPath: () => userData } },
};
const store = require('../../main/store.js');

test('corrupt preferences and reading history are backed up before defaults load', () => {
  const preferences = path.join(userData, 'preferences.json');
  const documents = path.join(userData, 'documents.json');
  fs.writeFileSync(preferences, '{ invalid preferences');
  fs.writeFileSync(documents, '{ invalid documents');

  store.load();
  const warnings = store.consumeLoadWarnings();
  assert.equal(warnings.length, 2);
  assert.match(warnings[0].message, /safe defaults/i);
  assert.ok(warnings.every(warning => warning.backup && fs.existsSync(warning.backup)));
  assert.equal(store.getPrefs().theme, 'system');
  assert.deepEqual(store.recents(), []);

  // A normal flush repairs the primary files without touching the preserved
  // corrupt copies, and both new files parse cleanly.
  store.flushSync();
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(preferences, 'utf8')));
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(documents, 'utf8')));
  assert.equal(fs.readdirSync(userData).filter(name => name.includes('.corrupt-')).length, 2);
});
