'use strict';
/** Main-process proxy for one MDX worker. */

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const START_TIMEOUT_MS = 120_000;
const LOOKUP_TIMEOUT_MS = 15_000;

class MdxWorkerClient {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.startTimeout = options.startTimeout || START_TIMEOUT_MS;
    this.lookupTimeout = options.lookupTimeout || LOOKUP_TIMEOUT_MS;
    this.worker = new Worker(options.workerPath || path.join(__dirname, 'mdx-worker.js'), {
      workerData: { filePath, modulePath: options.modulePath || '' },
    });
  }

  static open(filePath, options = {}) {
    const client = new MdxWorkerClient(filePath, options);
    return client.waitUntilReady();
  }

  waitUntilReady() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          this.close();
          reject(error);
        } else {
          resolve(this);
        }
      };
      const timer = setTimeout(() => finish(new Error('Dictionary took too long to load')), this.startTimeout);

      this.worker.on('message', (message) => {
        if (message?.type === 'ready') finish();
        else if (message?.type === 'init-error') finish(new Error(message.error || 'Could not load MDX'));
        else if (message?.type === 'result') this.onResult(message);
      });
      this.worker.once('error', error => {
        finish(error);
        this.failPending(error);
      });
      this.worker.once('exit', code => {
        this.closed = true;
        const error = code === 0
          ? new Error('Dictionary worker closed')
          : new Error(`Dictionary worker stopped unexpectedly (code ${code})`);
        if (!settled) finish(error);
        this.failPending(error);
      });
    });
  }

  onResult(message) {
    const request = this.pending.get(message.id);
    if (!request) return;
    this.pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.entry || null);
  }

  failPending(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  lookupCandidates(candidates) {
    if (this.closed) return Promise.reject(new Error('Dictionary worker is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error('Dictionary lookup timed out');
        // A timed-out worker may be stuck in native decompression or a
        // malformed index. Leaving it alive would make every later lookup
        // queue behind the same blocked operation and leak one worker until
        // quit. Retire it immediately; the UI tells the reader to Reload the
        // dictionary, which creates a fresh worker transactionally.
        this.closed = true;
        this.failPending(error);
        this.worker.terminate().catch(() => {});
        reject(error);
      }, this.lookupTimeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.worker.postMessage({ type: 'lookup', id, candidates });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.worker.postMessage({ type: 'close' }); } catch { /* already stopped */ }
    // Give the normal close message a chance, but do not let a stuck worker
    // keep Gloss alive during shutdown or dictionary removal.
    const timer = setTimeout(() => this.worker.terminate().catch(() => {}), 500);
    timer.unref?.();
    this.failPending(new Error('Dictionary was closed'));
  }
}

module.exports = { MdxWorkerClient };
