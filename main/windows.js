'use strict';
/**
 * Window + menu management: main window with persisted/clamped bounds,
 * native frame, read-mode fullscreen, application menu (source of truth
 * for global accelerators — the renderer only handles contextual keys),
 * and the About window.
 */

const { BrowserWindow, Menu, app, dialog, screen, nativeTheme } = require('electron');
const path = require('path');
const store = require('./store');

const APP_ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const MIN_VISIBLE = { width: 100, height: 64 };
const STATE_DEBOUNCE_MS = 500;

let mainWindow = null;
let aboutWindow = null;
let stateTimer = null;

function getMainWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

// ── Bounds restore/clamp ──────────────────────────────────────────────────────

function restoredBounds() {
  const saved = store.getPrefs().window.bounds;
  const fallback = { width: 1200, height: 860 };
  if (!saved) return fallback;

  const display = screen.getDisplayMatching(saved);
  const wa = display.workArea;
  const interW = Math.min(saved.x + saved.width, wa.x + wa.width) - Math.max(saved.x, wa.x);
  const interH = Math.min(saved.y + saved.height, wa.y + wa.height) - Math.max(saved.y, wa.y);
  if (interW < MIN_VISIBLE.width || interH < MIN_VISIBLE.height) {
    // Off-screen (monitor unplugged, tampered file): keep size, recenter.
    return {
      width: Math.min(saved.width, wa.width),
      height: Math.min(saved.height, wa.height),
    };
  }
  return {
    x: saved.x,
    y: saved.y,
    width: Math.min(saved.width, wa.width),
    height: Math.min(saved.height, wa.height),
  };
}

function attachStateHandlers(win) {
  const capture = () => {
    if (win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return;
    const bounds = win.getNormalBounds();
    store.setPrefsInternal(p => { p.window.bounds = bounds; });
  };
  const debounced = () => {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(capture, STATE_DEBOUNCE_MS);
  };
  win.on('resize', debounced);
  win.on('move', debounced);
  win.on('maximize', () => store.setPrefsInternal(p => { p.window.isMaximized = true; }));
  win.on('unmaximize', () => store.setPrefsInternal(p => { p.window.isMaximized = false; }));
  win.on('close', () => {
    clearTimeout(stateTimer);
    if (!win.isMaximized() && !win.isFullScreen()) {
      const bounds = win.getNormalBounds();
      store.setPrefsInternal(p => { p.window.bounds = bounds; });
    }
  });
}

// ── Main window ───────────────────────────────────────────────────────────────

function createMainWindow() {
  const bounds = restoredBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 680,
    minHeight: 480,
    icon: APP_ICON,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191817' : '#faf9f7',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });

  if (store.getPrefs().window.isMaximized) mainWindow.maximize();
  attachStateHandlers(mainWindow);

  const win = mainWindow;
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html')).catch((error) => {
    console.error('gloss: renderer failed to load:', error);
    dialog.showErrorBox('Gloss could not open its window',
      'The application interface could not be loaded. Your PDFs, dictionaries, and reading state were not changed.');
    if (!win.isDestroyed()) win.destroy();
    app.quit();
  });
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });

  // Read mode is fullscreen (GNOME convention for F11) + hidden chrome.
  mainWindow.on('enter-full-screen', () => sendCommand('readMode', true));
  mainWindow.on('leave-full-screen', () => sendCommand('readMode', false));

  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

function setReadMode(on) {
  const win = getMainWindow();
  if (win) {
    try { win.setFullScreen(!!on); } catch (error) {
      console.error('gloss: read mode change failed:', error?.message || error);
    }
  }
}

function sendCommand(name, arg) {
  const win = getMainWindow();
  if (win && !win.webContents.isDestroyed()) {
    try { win.webContents.send('gloss:cmd', { name, arg }); } catch { /* window closed between checks */ }
  }
}

// ── Theme ─────────────────────────────────────────────────────────────────────

function applyThemeSource() {
  // Keeps native chrome (menus, dialogs) in step with the app theme.
  nativeTheme.themeSource = store.getPrefs().theme;
}

// ── About window ──────────────────────────────────────────────────────────────

function createAboutWindow() {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.focus();
    return;
  }
  aboutWindow = new BrowserWindow({
    width: 420,
    height: 540,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: getMainWindow() || undefined,
    modal: true,
    title: 'About Gloss',
    icon: APP_ICON,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191817' : '#faf9f7',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const win = aboutWindow;
  win.loadFile(path.join(__dirname, '..', 'about.html'), {
    query: { version: app.getVersion(), electron: process.versions.electron },
  }).catch((error) => {
    console.error('gloss: About window failed to load:', error);
    if (!win.isDestroyed()) win.destroy();
    dialog.showErrorBox('About Gloss', 'The About window could not be loaded.');
  });
  aboutWindow.on('closed', () => { aboutWindow = null; });
}

// ── Application menu ──────────────────────────────────────────────────────────

/**
 * The renderer owns every shortcut below: it needs the focused element and
 * the active UI layer to decide what a key means. Menu items therefore
 * display their accelerator as a hint but do not register it
 * (registerAccelerator: false) — registering here too would fire both
 * handlers and, for example, zoom twice per keypress.
 */
const hint = (label, accelerator, command, extra = {}) => ({
  label,
  accelerator,
  registerAccelerator: false,
  click: () => sendCommand(command),
  ...extra,
});

function buildMenu() {
  const recentItems = store.recents().map(r => ({
    label: r.name || path.basename(r.path),
    enabled: r.exists,
    click: () => sendCommand('openRecent', r.path),
  }));

  const template = [
    {
      label: 'File',
      submenu: [
        hint('Open PDF…', 'CmdOrCtrl+O', 'open'),
        {
          label: 'Open Recent',
          submenu: recentItems.length > 0
            ? [...recentItems, { type: 'separator' }, { label: 'Clear Recent Files', click: () => sendCommand('clearRecents') }]
            : [{ label: 'No recent documents', enabled: false }],
        },
        { type: 'separator' },
        { label: 'Add Dictionaries…', click: () => sendCommand('addDictionaries') },
        hint('Document Properties…', 'CmdOrCtrl+I', 'docInfo'),
        hint('Print…', 'CmdOrCtrl+P', 'print'),
        hint('Preferences…', 'CmdOrCtrl+,', 'prefs'),
        { type: 'separator' },
        { role: 'close' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        hint('Zoom In', 'CmdOrCtrl+=', 'zoomIn'),
        hint('Zoom Out', 'CmdOrCtrl+-', 'zoomOut'),
        hint('Fit Width', 'CmdOrCtrl+0', 'fitWidth'),
        hint('Fit Page', 'CmdOrCtrl+Shift+0', 'fitPage'),
        { type: 'separator' },
        hint('Rotate Clockwise', 'R', 'rotateCw'),
        hint('Rotate Counterclockwise', 'Shift+R', 'rotateCcw'),
        hint('Two-Page Book Spread', 'V', 'toggleSpread'),
        hint('Cycle Page Appearance', 'CmdOrCtrl+Shift+D', 'cyclePageTone'),
        { type: 'separator' },
        hint('Bookmark This Page', 'CmdOrCtrl+B', 'toggleBookmark'),
        hint('Back', 'Alt+Left', 'historyBack'),
        hint('Forward', 'Alt+Right', 'historyForward'),
        { type: 'separator' },
        hint('Find in Document…', 'CmdOrCtrl+F', 'search'),
        hint('Look Up Selection', 'CmdOrCtrl+D', 'define'),
        { type: 'separator' },
        hint('Pages and Outline', 'F9', 'sidebar'),
        {
          label: 'Read Mode',
          accelerator: 'F11',
          registerAccelerator: false,
          click: () => setReadMode(!getMainWindow()?.isFullScreen()),
        },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'About Gloss', accelerator: 'F1', click: () => createAboutWindow() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = {
  createMainWindow, getMainWindow, createAboutWindow,
  buildMenu, sendCommand, setReadMode, applyThemeSource,
};
