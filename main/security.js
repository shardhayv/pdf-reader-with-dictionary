'use strict';
/**
 * Process-wide hardening. The app never navigates, never opens child
 * windows, never attaches webviews, and grants no web permissions.
 * External links open only through the shell:openExternal IPC channel
 * (http/https, user-initiated), so deny-all is correct everywhere here.
 */

const REQUEST_PERMISSION_DENIED = false;

function installAppHardening(app) {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', e => e.preventDefault());
    contents.on('will-frame-navigate', e => e.preventDefault());
    contents.on('will-redirect', e => e.preventDefault());
    contents.on('will-attach-webview', e => e.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}

function hardenSession(session) {
  session.setPermissionRequestHandler((_wc, _permission, callback) => callback(REQUEST_PERMISSION_DENIED));
  session.setPermissionCheckHandler(() => REQUEST_PERMISSION_DENIED);
  session.setDevicePermissionHandler(() => REQUEST_PERMISSION_DENIED);
}

/**
 * Every ipcMain.handle handler calls this first, synchronously, before any
 * await (Electron 33: senderFrame may be null/detached if read late).
 * Our windows host exactly one top-level file:// document and can never
 * navigate, so this pins messages to our own app frames.
 */
function trustedSender(event) {
  const frame = event.senderFrame;
  return !!frame && frame === event.sender.mainFrame && frame.url.startsWith('file://');
}

/** Wrap an ipcMain.handle callback with the sender guard. */
function guarded(handler) {
  return (event, ...args) => {
    if (!trustedSender(event)) throw new Error('gloss: IPC denied for untrusted sender');
    return handler(event, ...args);
  };
}

module.exports = { installAppHardening, hardenSession, trustedSender, guarded };
