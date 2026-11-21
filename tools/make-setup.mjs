// 우리 디자인 설치 프로그램 만들기
// release/win-unpacked(electron-builder --dir 결과)를 묶어 tools/setup/Setup.cs와 함께 컴파일한다.
// 결과: release/HangulEditor-Setup-<버전>.exe  (지우기 프로그램은 설치 폴더 안 "Uninstall 한글 편집기.exe")
// Windows 기본 .NET Framework 4의 csc.exe만 쓴다 (따로 설치할 것 없음)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const ver = pkg.version;
const rel = path.join(root, 'release');
const app = path.join(rel, 'win-unpacked');
const work = path.join(rel, 'setup-build');
const NET = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319';
const csc = path.join(NET, 'csc.exe');

if (!fs.existsSync(path.join(app, '한글 편집기.exe'))) throw new Error('release/win-unpacked가 없습니다. 먼저 electron-builder --win --dir');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

const ps = (script) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });

// 1) 아이콘(.ico): build/icon.png를 256·64·48·32·16 크기로 줄여 PNG 형식 아이콘으로 묶는다
const ico = path.join(root, 'build', 'icon.ico');
if (!fs.existsSync(ico) || fs.statSync(ico).mtimeMs < fs.statSync(path.join(root, 'build', 'icon.png')).mtimeMs) {
  const sizes = [256, 64, 48, 32, 16];
  const pngs = sizes.map((s) => path.join(work, `i${s}.png`));
  ps(`Add-Type -AssemblyName System.Drawing; $src=[Drawing.Image]::FromFile('${path.join(root, 'build', 'icon.png')}');` +
    sizes.map((s, i) => `$b=New-Object Drawing.Bitmap ${s},${s}; $g=[Drawing.Graphics]::FromImage($b); $g.InterpolationMode='HighQualityBicubic'; $g.SmoothingMode='HighQuality'; $g.PixelOffsetMode='HighQuality'; $g.DrawImage($src,0,0,${s},${s}); $b.Save('${pngs[i]}',[Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $b.Dispose();`).join('') +
    '$src.Dispose()');
  const datas = pngs.map((p) => fs.readFileSync(p));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let off = head.length;
  sizes.forEach((s, i) => {
    const o = 6 + i * 16;
    head.writeUInt8(s >= 256 ? 0 : s, o); head.writeUInt8(s >= 256 ? 0 : s, o + 1);
    head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(datas[i].length, o + 8); head.writeUInt32LE(off, o + 12);
    off += datas[i].length;
  });
  fs.writeFileSync(ico, Buffer.concat([head, ...datas]));
  console.log('아이콘 만듦:', ico);
}

// 2) 버전 정보
fs.writeFileSync(path.join(work, 'BuildInfo.cs'), `namespace HangulEditorSetup { static class BuildInfo { public const string Version = "${ver}"; } }\n`);

const refs = [
  `${NET}\\WPF\\PresentationFramework.dll`, `${NET}\\WPF\\PresentationCore.dll`, `${NET}\\WPF\\WindowsBase.dll`,
  `${NET}\\System.Xaml.dll`, `${NET}\\System.IO.Compression.dll`, `${NET}\\System.Windows.Forms.dll`, `${NET}\\System.Xml.dll`,
].map((r) => `/r:${r}`);
const src = path.join(root, 'tools', 'setup', 'Setup.cs');
const compile = (define, out, extra = []) => {
  const args = ['/nologo', '/target:winexe', '/platform:anycpu', '/optimize+', '/codepage:65001', `/define:${define}`,
    `/out:${out}`, `/win32icon:${ico}`, ...refs, `/resource:${path.join(root, 'build', 'icon.png')},logo.png`, ...extra,
    src, path.join(work, 'BuildInfo.cs')];
  try { execFileSync(csc, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }); }
  catch (e) { console.error(e.stdout || e.message); throw new Error(`${define} 컴파일 실패`); }
};

// 점검: node tools/make-setup.mjs --snap=<폴더>  → 설치·지우기 화면 각 단계를 그림으로만 뽑는다(창을 띄우지 않음)
const snap = process.argv.find((a) => a.startsWith('--snap='))?.slice(7);
if (snap) {
  for (const d of ['SETUP', 'UNINSTALL']) {
    const exe = path.join(work, `${d}.exe`);
    compile(d, exe);
    execFileSync(exe, [`--snap=${path.join(snap, d.toLowerCase())}`, ...(d === 'UNINSTALL' ? ['--target=C:\\none'] : [])]);
  }
  fs.rmSync(work, { recursive: true, force: true });
  console.log('화면 그림:', snap);
  process.exit(0);
}

// 3) 지우기 프로그램 → 프로그램 폴더 안에 넣는다
compile('UNINSTALL', path.join(app, 'Uninstall 한글 편집기.exe'));
console.log('지우기 프로그램 만듦');

// 4) 프로그램 폴더 묶기
const zip = path.join(work, 'payload.zip');
ps(`Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('${app}', '${zip}', [IO.Compression.CompressionLevel]::Optimal, $false)`);
console.log('묶음 크기(MB):', (fs.statSync(zip).size / 1048576).toFixed(1));

// 5) 설치 프로그램
const out = path.join(rel, `HangulEditor-Setup-${ver}.exe`);
compile('SETUP', out, [`/resource:${zip},payload.zip`]);
fs.rmSync(work, { recursive: true, force: true });
console.log('설치 프로그램:', out, `(${(fs.statSync(out).size / 1048576).toFixed(1)}MB)`);
