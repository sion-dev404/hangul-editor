// rhwp-studio 빌드 결과(public/studio/assets/index-*.js)에 공공누리 글꼴 연결 지점을 넣는다.
// rhwp가 "글꼴 이름 → 글꼴 파일" 표(압축된 이름이라 빌드마다 다름)를 쓰는 함수 맨 앞에
// window.__koglTn(표, 이름정리함수)를 부르게 한다. 실제 내용은 public/studio/kogl-hook.js(tools/studio-kogl-hook.js).
// 사용: node tools/patch-studio.mjs [studio 폴더]   (여러 번 실행해도 한 번만 들어간다)
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || 'public/studio');
const assets = path.join(dir, 'assets');
const file = fs.readdirSync(assets).find((f) => /^index-.*\.js$/.test(f));
if (!file) throw new Error(`index-*.js가 없습니다: ${assets}`);
const p = path.join(assets, file);
let src = fs.readFileSync(p, 'utf8');

const MARK = 'window.__koglTn&&window.__koglTn(';
if (src.includes(MARK)) {
  console.log('이미 들어가 있음:', file);
} else {
  // function Nn(e,t={}){let n=new Map,r=new Map,i=[On];for(let a of e){let e=a.trim(),o=kn(a);if(!o)continue;let s=En.get(o),c=Tn.get(o)
  const re = /function (\w+)\(e,t=\{\}\)\{(let n=new Map,r=new Map,i=\[\w+\];for\(let a of e\)\{let e=a\.trim\(\),o=(\w+)\(a\);if\(!o\)continue;let s=\w+\.get\(o\),c=(\w+)\.get\(o\))/;
  const m = src.match(re);
  if (!m) throw new Error('rhwp 글꼴 표를 쓰는 함수를 찾지 못했습니다 (rhwp 버전이 바뀌었으면 tools/patch-studio.mjs를 고쳐야 합니다)');
  const [all, fn, body, norm, table] = m;
  src = src.replace(all, `function ${fn}(e,t={}){${MARK}${table},${norm});${body}`);
  fs.writeFileSync(p, src);
  console.log(`넣음: ${file} (함수 ${fn}, 표 ${table}, 이름정리 ${norm})`);
}

// 기본 그리기 방식(Canvas 2D): rhwp는 Canvas 글꼴 설정을 감싸 "쓸 수 있는 글꼴"이 아니면 이름을 대체 글꼴로 바꾼다.
// 그 판단(u=…||웹글꼴목록.has(e)||…)에 공공누리 글꼴도 넣는다.
const MARK2 = 'window.__koglHas&&window.__koglHas(e)||';
if (!src.includes(MARK2)) {
  const re2 = /(u=r\.includeUnconfirmedOriginal===!0\|\|)(\w+\.has\(e\)\|\|)/;
  if (!re2.test(src)) throw new Error('rhwp 글꼴 사용 가능 판단 코드를 찾지 못했습니다 (tools/patch-studio.mjs를 고쳐야 합니다)');
  src = src.replace(re2, `$1${MARK2}$2`);
  fs.writeFileSync(p, src);
  console.log('넣음: 글꼴 사용 가능 판단');
}

// 서식 줄 글꼴 메뉴(rhwp 자체 모양 그대로)에 공공누리를 넣는다
//  - 분류 단추 맨 뒤에 "공공누리", "전체"에도 공공누리 글꼴 포함
//  - 목록에서 공공누리 글꼴 옆에 표시(window.__koglBadge)
const MARK3 = 'window.__koglMenu?window.__koglMenu():[]';
if (!src.includes(MARK3)) {
  const reCat = /(\w+=\[\{id:`all`,label:\w+\(`[^`]+`\)\}(?:,\{id:`\w+`,label:\w+\(`[^`]+`\)\})*,\{id:`system`,label:\w+\(`[^`]+`\)\})\]/;
  const reAll = /(case`all`:return this\.uniqueFontMenuEntries\(\[[^\]]*?)\]\)/;
  const reCase = /(getFontMenuEntries\(e\)\{[^]*?switch\(e\)\{)/;
  const reOpt = /t\.textContent=e\.label,t\.title=e\.label,/;
  for (const [n, re] of [['분류 목록', reCat], ['전체 분류', reAll], ['분류별 목록', reCase], ['목록 항목', reOpt]]) {
    if (!re.test(src)) throw new Error(`rhwp 글꼴 메뉴의 ${n} 코드를 찾지 못했습니다 (tools/patch-studio.mjs를 고쳐야 합니다)`);
  }
  src = src.replace(reCat, '$1,...(window.__koglMenu?[{id:`kogl`,label:`공공누리`}]:[])]');
  src = src.replace(reAll, `$1,...(${MARK3})])`);
  src = src.replace(reCase, `$1case\`kogl\`:return ${MARK3};`);
  src = src.replace(reOpt, 't.textContent=e.label,t.title=e.label,window.__koglBadge&&window.__koglBadge(t,e.value),');
  fs.writeFileSync(p, src);
  console.log('넣음: 글꼴 메뉴 공공누리 분류·표시');
}

// 여러 쪽 보기: rhwp의 확대 창(view:zoom-dialog)이 확인 때 하는 일을 그대로 하는 명령 view:arrange를 더한다.
// 매개변수 { arrangement: {kind:'single'} | {kind:'multiple',columns,rows}, zoomChoice?: {kind:'fitWidth'|'fitPage'} }
const MARK4 = 'id:`view:arrange`';
if (!src.includes(MARK4)) {
  const reZoom = /id:`view:zoom-dialog`,[^]*?execute\(e\)\{let t=e\.getViewportManager\(\);if\(!t\)return;let n=(\w+)\.getViewSettings\(\)[^]*?onConfirm\(t\)\{([^]*?e\.eventBus\.emit\(`command-state-changed`\))\}\}\)\.show\(\)\}\}/;
  const m4 = src.match(reZoom);
  if (!m4) throw new Error('rhwp 확대 창 명령 코드를 찾지 못했습니다 (tools/patch-studio.mjs를 고쳐야 합니다)');
  const [all, S, body] = m4;
  const cmd = `,{${MARK4},label:\`쪽 배치\`,canExecute:e=>e.hasDocument,execute(e,p){if(!p||!p.arrangement)return;let t={zoomChoice:p.zoomChoice||{kind:\`fitPage\`},arrangement:p.arrangement,pageMovement:${S}.getViewSettings().pageMovement};${body}}}`;
  src = src.replace(all, all + cmd);
  fs.writeFileSync(p, src);
  console.log('넣음: 쪽 배치 명령(view:arrange)');
}

// kogl-hook.js를 rhwp 본체보다 먼저 읽게 한다
const hook = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), 'studio-kogl-hook.js');
fs.copyFileSync(hook, path.join(dir, 'kogl-hook.js'));
const ip = path.join(dir, 'index.html');
let html = fs.readFileSync(ip, 'utf8');
if (!html.includes('kogl-hook.js')) {
  html = html.replace('<script src="./theme-init.js"></script>', '<script src="./kogl-hook.js"></script>\n  <script src="./theme-init.js"></script>');
  fs.writeFileSync(ip, html);
}
// 인쇄 창에도 넣는다 (인쇄 페이지의 SVG 글자가 공공누리 글꼴을 쓸 수 있게)
const pp = path.join(dir, 'print.html');
if (fs.existsSync(pp)) {
  let ph = fs.readFileSync(pp, 'utf8');
  if (!ph.includes('kogl-hook.js')) {
    ph = ph.replace('</head>', '  <script src="./kogl-hook.js"></script>\n</head>');
    fs.writeFileSync(pp, ph);
  }
}
console.log('kogl-hook.js 복사 완료');
