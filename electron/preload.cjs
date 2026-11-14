const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  initialFile: () => ipcRenderer.invoke('initial-file'),
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  hasHancom: () => ipcRenderer.invoke('has-hancom'),
  saveFile: (o) => ipcRenderer.invoke('save-file', o),
  convert: (o) => ipcRenderer.invoke('convert', o),
  openInHangul: (o) => ipcRenderer.invoke('open-in-hangul', o),
  onOpenFile: (cb) => ipcRenderer.on('open-file', (_e, f) => cb(f)),
});
