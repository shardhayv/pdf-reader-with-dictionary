'use strict';
/**
 * Isolated MDX parser/lookup worker.
 *
 * js-mdict builds its key index synchronously. Doing that in Electron's main
 * process freezes the window for large dictionaries, so each MDX lives here.
 * The worker receives the whole candidate ladder in one message and returns
 * the first exact hit, preserving the same lookup contract as JSON glossaries.
 */

const { parentPort, workerData } = require('node:worker_threads');

let mdx = null;
const MAX_DEFINITION_LENGTH = 512 * 1024;

function messageFor(error) {
  return error && error.message ? String(error.message).slice(0, 500) : 'Unknown MDX error';
}

try {
  const { MDX } = require(workerData.modulePath || 'js-mdict');
  mdx = new MDX(workerData.filePath);
  parentPort.postMessage({ type: 'ready' });
} catch (error) {
  parentPort.postMessage({ type: 'init-error', error: messageFor(error) });
}

parentPort.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'close') {
    try { mdx?.close(); } catch { /* worker is exiting anyway */ }
    mdx = null;
    parentPort.close();
    return;
  }
  if (message.type !== 'lookup' || !Number.isInteger(message.id)) return;
  if (!mdx) {
    parentPort.postMessage({ type: 'result', id: message.id, error: 'Dictionary is not available' });
    return;
  }

  try {
    for (const candidate of Array.isArray(message.candidates) ? message.candidates : []) {
      const entry = mdx.lookup(candidate);
      if (entry && typeof entry.definition === 'string' && entry.definition.length > 0) {
        parentPort.postMessage({
          type: 'result',
          id: message.id,
          entry: {
            keyText: typeof entry.keyText === 'string' ? entry.keyText.slice(0, 300) : candidate,
            definition: entry.definition.slice(0, MAX_DEFINITION_LENGTH),
            matchedCandidate: candidate,
          },
        });
        return;
      }
    }
    parentPort.postMessage({ type: 'result', id: message.id, entry: null });
  } catch (error) {
    parentPort.postMessage({ type: 'result', id: message.id, error: messageFor(error) });
  }
});
