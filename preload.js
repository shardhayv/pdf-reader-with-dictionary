const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // PDF
  openPDF:              ()          => ipcRenderer.invoke('dialog:openPDF'),
  readPDF:              (p)         => ipcRenderer.invoke('file:readPDF', p),

  // Dictionary
  openMDX:              ()          => ipcRenderer.invoke('dialog:openMDX'),        // → path[] | null
  loadDictionaries:     (paths)     => ipcRenderer.invoke('dictionary:loadMultiple', paths),
  listDictionaries:     ()          => ipcRenderer.invoke('dictionary:list'),
  removeDictionary:     (p)         => ipcRenderer.invoke('dictionary:remove', p),
  reorderDictionaries:  (order)     => ipcRenderer.invoke('dictionary:reorder', order),
  toggleDictionary:     (p)         => ipcRenderer.invoke('dictionary:toggle', p),
  lookupAll:            (word)      => ipcRenderer.invoke('dictionary:lookupAll', word),

  // Wikipedia
  lookupWikipedia:      (word)      => ipcRenderer.invoke('wikipedia:lookup', word),

  // Preferences
  getPreferences:       ()          => ipcRenderer.invoke('preferences:get'),
  savePreferences:      (delta)     => ipcRenderer.invoke('preferences:save', delta),

  // Shell
  openExternal:         (url)       => ipcRenderer.invoke('shell:openExternal', url),
});
