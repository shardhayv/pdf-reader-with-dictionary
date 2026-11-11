'use strict';
/**
 * Process-wide hardening. The app never navigates, never opens child
 * windows, never attaches webviews, and grants no web permissions.
 * External links open only through the shell:openExternal IPC channel
 * (http/https, user-initiated), so deny-all is correct everywhere here.
 */

const REQUEST_PERMISSION_DENIED = false;

/**
 * The one web permission Gloss grants, and only to its own page: writing
 * text the reader explicitly asked to copy (a definition, a file path, the
 * vocabulary export). Chromium routes navigator.clipboard.writeText through
 * the permission handlers below, so a blanket deny silently broke every Copy
 * button. Reading the clipboard stays denied.
 */
const GRANTED_TO_APP = new Set(['clipboard-sanitized-write']);

function isAppOrigin(url) {
  return typeof url === 'string' && url.startsWith('file://');
}

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
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requester = details?.requestingUrl || webContents?.getURL?.() || '';
    callback(GRANTED_TO_APP.has(permission) && isAppOrigin(requester));
  });
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (!GRANTED_TO_APP.has(permission)) return REQUEST_PERMISSION_DENIED;
    const requester = details?.requestingUrl || requestingOrigin || webContents?.getURL?.() || '';
    return isAppOrigin(requester);
  });
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
