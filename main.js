const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const https = require('https');

// ─── State ────────────────────────────────────────────────────────────────────
let mainWindow;

// key: filePath  value: { name, path, mdx, enabled }
const dictionaries = new Map();

let preferences = {
  dictionaryOrder:    [],   // file paths in lookup-priority order
  dictionaryEnabled:  {},   // { [filePath]: boolean }
  wikipediaEnabled:   true,
  wikipediaAsFallback: true,
  theme:              'system',
};

// ─── Preferences persistence ─────────────────────────────────────────────────
function prefsFilePath() {
  return path.join(app.getPath('userData'), 'preferences.json');
}

function loadPreferences() {
  try {
    const raw = fs.readFileSync(prefsFilePath(), 'utf8');
    preferences = { ...preferences, ...JSON.parse(raw) };
  } catch (_) { /* first run — keep defaults */ }
}

function savePreferences() {
  try {
    // Keep dictionaryOrder + enabled in sync with current in-memory state
    preferences.dictionaryOrder   = [...dictionaries.keys()];
    preferences.dictionaryEnabled = {};
    for (const [p, d] of dictionaries) preferences.dictionaryEnabled[p] = d.enabled;
    fs.writeFileSync(prefsFilePath(), JSON.stringify(preferences, null, 2), 'utf8');
  } catch (err) { console.error('prefs save failed:', err.message); }
}

// ─── Startup dictionary restore ───────────────────────────────────────────────
async function restoreDictionaries() {
  if (!preferences.dictionaryOrder || preferences.dictionaryOrder.length === 0) return;
  let { MDX } = require('js-mdict');
  for (const filePath of preferences.dictionaryOrder) {
    if (!fs.existsSync(filePath)) { console.warn('Saved dict not found:', filePath); continue; }
    try {
      const mdx     = new MDX(filePath);
      const name    = path.basename(filePath, '.mdx');
      const enabled = preferences.dictionaryEnabled[filePath] !== false;
      dictionaries.set(filePath, { name, path: filePath, mdx, enabled });
    } catch (err) { console.warn('Could not restore dict:', filePath, err.message); }
  }
}

// ─── Window ───────────────────────────────────────────────────────────────────
const APP_ICON = path.join(__dirname, 'assets', 'icon.png');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 900, minWidth: 800, minHeight: 600,
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

// ─── About window ─────────────────────────────────────────────────────────────
function createAboutWindow() {
  const about = new BrowserWindow({
    width: 480,
    height: 580,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: mainWindow,
    modal: true,
    title: 'About Gloss',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    autoHideMenuBar: true,
    backgroundColor: '#0f0f0f',
    icon: APP_ICON,
  });
  about.loadFile(path.join(__dirname, 'about.html'));
}

// ─── Application menu ─────────────────────────────────────────────────────────
function buildMenu() {
  const template = [
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Gloss',
          accelerator: 'F1',
          click: () => createAboutWindow(),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  loadPreferences();
  await restoreDictionaries();
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ─── IPC: Dialogs ─────────────────────────────────────────────────────────────
ipcMain.handle('dialog:openPDF', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Open PDF', filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
    properties: ['openFile'],
  });
  return r.canceled ? null : r.filePaths[0];
});

// Returns array of selected .mdx paths (or null)
ipcMain.handle('dialog:openMDX', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Add Dictionary (.mdx)',
    filters: [{ name: 'MDict Dictionary', extensions: ['mdx'] }],
    properties: ['openFile', 'multiSelections'],
  });
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths;
});

// ─── IPC: Multi-dictionary load ───────────────────────────────────────────────
ipcMain.handle('dictionary:loadMultiple', async (_e, filePaths) => {
  const { MDX } = require('js-mdict');
  const results = [];
  for (const filePath of filePaths) {
    if (dictionaries.has(filePath)) {
      results.push({ name: dictionaries.get(filePath).name, path: filePath, success: true, alreadyLoaded: true });
      continue;
    }
    try {
      const mdx  = new MDX(filePath);
      const name = path.basename(filePath, '.mdx');
      dictionaries.set(filePath, { name, path: filePath, mdx, enabled: true });
      if (!preferences.dictionaryOrder.includes(filePath)) preferences.dictionaryOrder.push(filePath);
      results.push({ name, path: filePath, success: true });
    } catch (err) {
      results.push({ name: path.basename(filePath, '.mdx'), path: filePath, success: false, error: err.message });
    }
  }
  savePreferences();
  return results;
});

// ─── IPC: Dictionary management ───────────────────────────────────────────────
ipcMain.handle('dictionary:list', () =>
  preferences.dictionaryOrder
    .filter(p => dictionaries.has(p))
    .map(p => { const d = dictionaries.get(p); return { name: d.name, path: d.path, enabled: d.enabled }; })
);

ipcMain.handle('dictionary:remove', (_e, filePath) => {
  dictionaries.delete(filePath);
  preferences.dictionaryOrder = preferences.dictionaryOrder.filter(p => p !== filePath);
  delete preferences.dictionaryEnabled[filePath];
  savePreferences();
  return { success: true };
});

ipcMain.handle('dictionary:reorder', (_e, newOrder) => {
  preferences.dictionaryOrder = newOrder.filter(p => dictionaries.has(p));
  savePreferences();
  return { success: true };
});

ipcMain.handle('dictionary:toggle', (_e, filePath) => {
  const dict = dictionaries.get(filePath);
  if (!dict) return { success: false };
  dict.enabled = !dict.enabled;
  savePreferences();
  return { success: true, enabled: dict.enabled };
});

// ─── IPC: Lookup all enabled dicts in priority order ─────────────────────────
ipcMain.handle('dictionary:lookupAll', (_e, word) => {
  const clean = word.replace(/^[^a-zA-Z\u00C0-\u024F]+|[^a-zA-Z\u00C0-\u024F]+$/g, '').toLowerCase();
  if (!clean) return [];
  const results = [];
  for (const filePath of preferences.dictionaryOrder) {
    const dict = dictionaries.get(filePath);
    if (!dict || !dict.enabled) continue;
    try {
      const entry = dict.mdx.lookup(clean);
      if (entry && entry.definition) {
        results.push({ found: true, dictName: dict.name, dictPath: filePath,
          word: entry.keyText || clean, definition: entry.definition });
      }
    } catch (_) { /* skip */ }
  }
  return results;
});

// ─── IPC: Preferences ────────────────────────────────────────────────────────
ipcMain.handle('preferences:get', () => ({ ...preferences }));

ipcMain.handle('preferences:save', (_e, delta) => {
  const allowed = ['wikipediaEnabled', 'wikipediaAsFallback', 'theme'];
  for (const key of allowed) { if (key in delta) preferences[key] = delta[key]; }
  savePreferences();
  return { success: true };
});

// ─── IPC: File read ───────────────────────────────────────────────────────────
ipcMain.handle('file:readPDF', (_e, filePath) => {
  try { return fs.readFileSync(filePath).toString('base64'); }
  catch (_) { return null; }
});

// ─── IPC: Wikipedia ───────────────────────────────────────────────────────────
ipcMain.handle('wikipedia:lookup', async (_e, word) => {
  try {
    const json = JSON.parse(await httpsGet(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(word)}`
    ));
    if (json.type === 'disambiguation' || !json.extract || !json.extract.trim()) return null;
    return {
      title:   json.title,
      extract: json.extract,
      url:     (json.content_urls?.desktop?.page) || `https://en.wikipedia.org/wiki/${encodeURIComponent(word)}`,
    };
  } catch (_) { return null; }
});

// ─── IPC: Shell ───────────────────────────────────────────────────────────────
ipcMain.handle('shell:openExternal', (_e, url) => shell.openExternal(url));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'electron-pdf-reader/1.0' } }, res => {
      if (res.statusCode === 404) { reject(new Error('not found')); return; }
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}
