// 설치형(.exe) 껍데기: 편집 화면을 창으로 띄우고 파일 열기/저장을 맡는다
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

let win = null;
const DOC_RE = /\.(hwp|hwpx|docx)$/i;

function fileFromArgv(argv) {
  const p = argv.slice(1).find((a) => DOC_RE.test(a) && fs.existsSync(a));
  return p || null;
}
function readDoc(p) {
  try { return { name: path.basename(p), data: fs.readFileSync(p) }; } catch { return null; }
}

let pendingFile = fileFromArgv(process.argv);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const p = fileFromArgv(argv);
    const f = p && readDoc(p);
    if (f) win.webContents.send('open-file', f);
  });

  app.whenReady().then(() => {
    win = new BrowserWindow({
      width: 1300, height: 900, minWidth: 480, minHeight: 400,
      title: '한글 편집기',
      icon: path.join(__dirname, '..', 'build', 'icon.png'),
      autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
    });
    win.setMenu(null);
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.on('closed', () => { win = null; });
  });

  app.on('window-all-closed', () => app.quit());
}

ipcMain.handle('initial-file', () => {
  const f = pendingFile && readDoc(pendingFile);
  pendingFile = null;
  return f;
});

function hasHancom() {
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKCR\\HWPFrame.HwpObject'], { windowsHide: true }, (err) => resolve(!err));
  });
}
ipcMain.handle('has-hancom', hasHancom);

// 자동 점검용: 환경 변수로 저장 위치를 주면 대화 상자를 건너뛴다
const askSave = (opt) => (process.env.HANGUL_EDITOR_SAVE_TO
  ? Promise.resolve({ canceled: false, filePath: process.env.HANGUL_EDITOR_SAVE_TO + path.extname(opt.defaultPath) })
  : dialog.showSaveDialog(win, opt));

ipcMain.handle('save-file', async (_e, { name, ext, data }) => {
  const r = await askSave({
    title: '저장하기',
    defaultPath: path.join(app.getPath('documents'), `${name}.${ext}`),
    filters: [{ name: ext === 'docx' ? '워드 문서' : '문서', extensions: [ext] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(data));
  return r.filePath;
});

// 한컴오피스 한글을 불러서 docx → hwp 로 바꾼다
const PS_CONVERT = `param($src,$dst)
$ErrorActionPreference = 'Stop'
$h = New-Object -ComObject HWPFrame.HwpObject
try {
  $h.RegisterModule('FilePathCheckDLL','FilePathCheckerModule') | Out-Null
  if (-not $h.Open($src,'','forceopen:true')) { throw 'open failed' }
  if (-not $h.SaveAs($dst,'HWP','')) { throw 'save failed' }
  'OK'
} finally { $h.Quit() }
`;

ipcMain.handle('save-hwp', async (_e, { name, data }) => {
  const r = await askSave({
    title: '한글 문서로 저장하기',
    defaultPath: path.join(app.getPath('documents'), `${name}.hwp`),
    filters: [{ name: '한글 문서', extensions: ['hwp'] }],
  });
  if (r.canceled || !r.filePath) return { canceled: true };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangul-editor-'));
  const src = path.join(dir, 'source.docx');
  const script = path.join(dir, 'convert.ps1');
  const tmpOut = path.join(dir, 'result.hwp');
  try {
    fs.writeFileSync(src, Buffer.from(data));
    fs.writeFileSync(script, PS_CONVERT, 'utf8');
    const out = await new Promise((resolve, reject) => {
      execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, src, tmpOut],
        { windowsHide: true, timeout: 120000 },
        (err, stdout, stderr) => (err ? reject(new Error(err.killed ? '시간 초과' : (stderr || err.message).trim().split('\n')[0])) : resolve(stdout)));
    });
    if (!/OK/.test(out) || !fs.existsSync(tmpOut)) throw new Error('변환 실패');
    fs.copyFileSync(tmpOut, r.filePath);
    return { ok: true, path: r.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
});
