// 설치형(.exe) 껍데기: 편집 화면을 창으로 띄우고 파일 열기/저장/변환을 맡는다
const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { execFile, spawn } = require('child_process');

let win = null;
const DOC_RE = /\.(hwp|hwpx|docx)$/i;
const ROOT = path.join(__dirname, '..', 'dist');
const PORT = 47615; // 주소가 바뀌면 자동 저장 내용이 안 보이므로 고정한다
const HWP2024 = 'C:\\Program Files (x86)\\HNC\\Office 2024\\HOffice130\\Bin\\Hwp.exe';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf', '.webmanifest': 'application/manifest+json',
};

// rhwp 편집기는 http 주소에서만 동작하므로, 이 PC 안에서만 보이는 작은 서버로 화면 파일을 내준다
function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p;
      try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); res.end(); return; }
      if (p.endsWith('/')) p += 'index.html';
      const f = path.normalize(path.join(ROOT, p));
      if (!f.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      fs.readFile(f, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(data);
      });
    });
    let retried = false;
    srv.on('error', () => { if (!retried) { retried = true; srv.listen(0, '127.0.0.1'); } });
    srv.on('listening', () => resolve(srv.address().port));
    srv.listen(PORT, '127.0.0.1');
  });
}

function fileFromArgv(argv) {
  return argv.slice(1).find((a) => DOC_RE.test(a) && fs.existsSync(a)) || null;
}
function readDoc(p) {
  try { return { name: path.basename(p), data: fs.readFileSync(p), path: p }; } catch { return null; }
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

  app.whenReady().then(async () => {
    const port = await startServer();
    const origin = `http://127.0.0.1:${port}`;
    // 붙이기(클립보드)와 PC에 깔린 글꼴 사용은 이 프로그램 화면에만 허용한다
    const ALLOW = new Set(['clipboard-read', 'clipboard-sanitized-write', 'local-fonts']);
    session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(ALLOW.has(perm) && wc.getURL().startsWith(origin)));
    session.defaultSession.setPermissionCheckHandler((_wc, perm, reqOrigin) => ALLOW.has(perm) && String(reqOrigin || '').startsWith(origin));

    win = new BrowserWindow({
      width: 1400, height: 950, minWidth: 480, minHeight: 400,
      title: '한글 편집기',
      icon: path.join(__dirname, '..', 'build', 'icon.png'),
      autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
    });
    win.setMenu(null);
    win.loadURL(`${origin}/index.html`);
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(origin)) return { action: 'allow' }; // 인쇄 미리 보기 같은 편집기 자체 창
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

ipcMain.handle('open-dialog', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '문서 불러오기',
    properties: ['openFile'],
    filters: [{ name: '문서 (한글, 워드)', extensions: ['hwp', 'hwpx', 'docx'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return readDoc(r.filePaths[0]);
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

const KIND = { docx: '워드 문서', hwp: '한글 문서', hwpx: '한글 문서 (HWPX)' };
function saveOptions(name, ext, dir) {
  const base = dir && fs.existsSync(dir) ? dir : app.getPath('documents');
  return {
    title: '저장하기',
    defaultPath: path.join(base, `${name}.${ext}`),
    filters: [{ name: KIND[ext] || '문서', extensions: [ext] }],
  };
}

ipcMain.handle('save-file', async (_e, { name, ext, data, dir }) => {
  const r = await askSave(saveOptions(name, ext, dir));
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(data));
  return r.filePath;
});

// 한컴오피스 한글에게 형식 변환을 맡긴다 (docx ↔ hwp)
const PS_CONVERT = `param($src,$dst,$fmt)
$ErrorActionPreference = 'Stop'
$h = New-Object -ComObject HWPFrame.HwpObject
try {
  $h.RegisterModule('FilePathCheckDLL','FilePathCheckerModule') | Out-Null
  if (-not $h.Open($src,'','forceopen:true')) { throw 'open failed' }
  if (-not $h.SaveAs($dst,$fmt,'')) { throw 'save failed' }
  'OK'
} finally { $h.Quit() }
`;
const HWP_FORMAT = { hwp: 'HWP', hwpx: 'HWPX', docx: 'OOXML' };

ipcMain.handle('convert', async (_e, { name, data, from, to, dir }) => {
  if (!HWP_FORMAT[to] || !/^(hwp|hwpx|docx)$/.test(from)) return { ok: false, error: '지원하지 않는 형식' };
  const r = await askSave(saveOptions(name, to, dir));
  if (r.canceled || !r.filePath) return { canceled: true };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangul-editor-'));
  const src = path.join(tmp, `source.${from}`);
  const script = path.join(tmp, 'convert.ps1');
  const tmpOut = path.join(tmp, `result.${to}`);
  try {
    fs.writeFileSync(src, Buffer.from(data));
    fs.writeFileSync(script, PS_CONVERT, 'utf8');
    const out = await new Promise((resolve, reject) => {
      execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, src, tmpOut, HWP_FORMAT[to]],
        { windowsHide: true, timeout: 120000 },
        (err, stdout, stderr) => (err ? reject(new Error(err.killed ? '시간 초과' : (stderr || err.message).trim().split('\n')[0])) : resolve(stdout)));
    });
    if (!/OK/.test(out) || !fs.existsSync(tmpOut)) throw new Error('변환 실패');
    fs.copyFileSync(tmpOut, r.filePath);
    return { ok: true, path: r.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    fs.rm(tmp, { recursive: true, force: true }, () => {});
  }
});

// 지금 문서를 임시 파일로 내보내 실제 한글 프로그램에서 열어 본다 (원본과 똑같은지 확인용)
ipcMain.handle('open-in-hangul', async (_e, { name, data }) => {
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangul-editor-view-'));
    const f = path.join(tmp, `${String(name || '문서').replace(/[\\/:*?"<>|]/g, '_')}.hwp`);
    fs.writeFileSync(f, Buffer.from(data));
    if (fs.existsSync(HWP2024)) {
      spawn(HWP2024, [f], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true };
    }
    const err = await shell.openPath(f);
    return err ? { ok: false, error: '한글 프로그램을 찾지 못했습니다' } : { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
