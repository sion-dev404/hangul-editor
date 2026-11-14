const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  initialFile: () => ipcRenderer.invoke('initial-file'),
  hasHancom: () => ipcRenderer.invoke('has-hancom'),
  saveFile: (o) => ipcRenderer.invoke('save-file', o),
  saveHwp: (o) => ipcRenderer.invoke('save-hwp', o),
  onOpenFile: (cb) => ipcRenderer.on('open-file', (_e, f) => cb(f)),
});
