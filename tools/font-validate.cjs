// 글꼴 파일들이 이 프로그램의 화면 엔진(Electron = Chromium)에서 실제로 열리는지 시험한다.
// 사용: electron tools/font-validate.cjs <파일 목록 json> <결과 json>
// (Chromium은 글꼴 검사(OTS)에 걸린 파일을 거부하므로, 미리 걸러 둔다)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

app.whenReady().then(async () => {
  const [listFile, outFile] = process.argv.slice(-2);
  const list = JSON.parse(fs.readFileSync(listFile, 'utf8'));
  const html = path.join(path.dirname(outFile), 'font-validate.html');
  fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><title>v</title>');
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  await win.loadFile(html);
  // 글꼴 검사(OTS)가 거부한 이유는 화면 콘솔에 찍힌다
  const why = [];
  win.webContents.on('console-message', (_e, _lvl, msg) => { if (/OTS|font/i.test(msg)) why.push(msg); });
  const results = [];
  for (const p of list) {
    const url = pathToFileURL(p).href;
    // eslint-disable-next-line no-await-in-loop
    const ok = await win.webContents.executeJavaScript(
      `new FontFace('t${results.length}', 'url("${url}") format("woff")').load().then(() => true, () => false)`);
    results.push(ok);
  }
  fs.writeFileSync(outFile, JSON.stringify(results));
  fs.writeFileSync(`${outFile}.why.txt`, why.join('\n'));
  app.quit();
});
