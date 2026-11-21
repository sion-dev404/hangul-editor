const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  initialFile: () => ipcRenderer.invoke('initial-file'),
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  hasHancom: () => ipcRenderer.invoke('has-hancom'),
  saveFile: (o) => ipcRenderer.invoke('save-file', o),
  convert: (o) => ipcRenderer.invoke('convert', o),
  convertBytes: (o) => ipcRenderer.invoke('convert-bytes', o),
  openInHangul: (o) => ipcRenderer.invoke('open-in-hangul', o),
  onOpenFile: (cb) => ipcRenderer.on('open-file', (_e, f) => cb(f)),
  // 클라우드 로그인 1회용 코드 (한 번만 받고 끝낸다)
  onAuthCode: (cb) => {
    const h = (_e, code) => { ipcRenderer.removeListener('auth-code', h); cb(code); };
    ipcRenderer.on('auth-code', h);
    return () => ipcRenderer.removeListener('auth-code', h);
  },
});
