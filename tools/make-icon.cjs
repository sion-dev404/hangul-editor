// 로고 SVG → 아이콘 PNG (투명 바탕). Electron으로 그린다.
//   npx electron tools/make-icon.cjs <입력.svg> <출력.png> [크기=512]
// 예) public/logo.svg → build/icon.png (설치판 아이콘; tools/make-setup.mjs가 여기서 .ico를 만든다)
// VS Code 터미널에서는 ELECTRON_RUN_AS_NODE를 지우고 실행해야 한다.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('make-icon.cjs')) + 1);
const [inp, out, sizeArg] = args;
const size = Number(sizeArg) || 512;
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(async () => {
  try {
    const svg = fs.readFileSync(path.resolve(inp), 'utf8');
    const w = new BrowserWindow({ show: false, width: 200, height: 200 });
    await w.loadURL('data:text/html,<meta charset=utf-8><body></body>');
    const dataUrl = await w.webContents.executeJavaScript(`new Promise((ok, no) => {
      const img = new Image();
      img.onload = () => { const c = document.createElement('canvas'); c.width = c.height = ${size};
        c.getContext('2d').drawImage(img, 0, 0, ${size}, ${size}); ok(c.toDataURL('image/png')); };
      img.onerror = () => no(new Error('SVG를 그리지 못했습니다'));
      img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
    })`);
    fs.writeFileSync(path.resolve(out), Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`만듦: ${out} (${size}px)`);
    app.exit(0);
  } catch (e) { console.error(e.message || e); app.exit(1); }
});
