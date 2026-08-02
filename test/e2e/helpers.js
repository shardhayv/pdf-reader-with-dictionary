'use strict';
/** Shared launch helper for Electron specs. */

const { _electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO = path.join(__dirname, '..', '..');
const FIXTURES = path.join(REPO, 'test', 'fixtures');

/**
 * The dev Electron's chrome-sandbox is not setuid on distributions that
 * also restrict unprivileged user namespaces (Ubuntu 24.04+), so the
 * binary cannot sandbox itself and refuses to start. This disables the
 * sandbox for the TEST HARNESS ONLY — the application never does this,
 * and packaged builds ship a correctly setuid helper (build/deb-after-install.sh).
 * Set GLOSS_TEST_SANDBOX=1 once you have run:
 *   sudo chown root:root node_modules/electron/dist/chrome-sandbox
 *   sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
 */
const SANDBOX_ARGS = process.env.GLOSS_TEST_SANDBOX === '1' ? [] : ['--no-sandbox'];

function fixture(name) {
  const p = path.join(FIXTURES, name);
  if (!fs.existsSync(p)) {
    throw new Error(`Missing fixture ${name}. Run: npm run fixtures`);
  }
  return p;
}

/**
 * Launch Gloss with an isolated userData directory so specs never read or
 * write the developer's real preferences and recent-file list.
 */
async function launchGloss({ open = null, extraArgs = [], userDataDir = null } = {}) {
  const dataDir = userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-e2e-'));
  const args = [
    ...SANDBOX_ARGS,
    `--user-data-dir=${dataDir}`,
    '.',
    ...extraArgs,
  ];
  if (open) args.push(fixture(open));

  const app = await _electron.launch({ args, cwd: REPO });
  const page = await app.firstWindow();
  await page.waitForSelector('body[data-ready="1"]', { timeout: 30_000 });
  return { app, page, dataDir };
}

/** Wait until the first page canvas has painted. */
async function waitForDocument(page) {
  await page.waitForSelector('.pdf-page-wrapper[data-rendered="true"] canvas', { timeout: 30_000 });
  await page.waitForTimeout(350);
}

/** Collect console errors and uncaught exceptions for assertions. */
function collectErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  return errors;
}

module.exports = { REPO, FIXTURES, SANDBOX_ARGS, fixture, launchGloss, waitForDocument, collectErrors };
