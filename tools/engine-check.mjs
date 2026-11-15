// 엔진(WASM)을 Node에서 직접 돌리는 진단 도구
// 사용: node eng.mjs <pkg 폴더> <문서> <명령> [쪽]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [pkgDir, file, cmd = 'svg', pageArg = '0'] = process.argv.slice(2);
globalThis.measureTextWidth = (font, text) => {
  const m = /([\d.]+)px/.exec(font); const px = m ? +m[1] : 16;
  let w = 0;
  for (const ch of text) { const c = ch.codePointAt(0); w += c > 0x2e80 ? px : (c === 32 ? px * 0.3 : px * 0.55); }
  return w;
};
const mod = await import(pathToFileURL(path.join(pkgDir, 'rhwp.js')).href);
mod.initSync({ module: fs.readFileSync(path.join(pkgDir, 'rhwp_bg.wasm')) });
const doc = new mod.HwpDocument(new Uint8Array(fs.readFileSync(file)));
const page = +pageArg;
if (process.env.REFLOW) console.error('reflowLinesegs →', doc.reflowLinesegs());
// 실험: OPS="delpic:4:0;delshape:4:1;shape:5:0:{json}"
for (const op of (process.env.OPS || '').split(';').filter(Boolean)) {
  const [kind, p, c, ...rest] = op.split(':');
  try {
    if (kind === 'delpic') console.log('#', op, doc.deletePictureControl(0, +p, +c));
    if (kind === 'delshape') console.log('#', op, doc.deleteShapeControl(0, +p, +c));
    if (kind === 'pic') console.log('#', op, doc.setPictureProperties(0, +p, +c, rest.join(':')));
    if (kind === 'shape') console.log('#', op, doc.setShapeProperties(0, +p, +c, rest.join(':')));
  } catch (e) { console.log('#', op, '오류', String(e)); }
}
if (cmd === 'svg') {
  const svg = doc.renderPageSvg(page);
  fs.writeFileSync(`eng-page${page}.svg`, svg);
  // 글자를 줄(y)별로 모아 보여 준다
  const rows = new Map();
  for (const m of svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>([^<]*)<\/text>/g)) {
    const y = Math.round(+m[2]); if (!rows.has(y)) rows.set(y, []); rows.get(y).push([+m[1], m[3]]);
  }
  for (const [y, list] of [...rows].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => a[0] - b[0]);
    console.log(String(y).padStart(5), Math.round(list[0][0]).toString().padStart(4), list.map((x) => x[1]).join(''));
  }
} else if (cmd === 'layout') {
  console.log(doc.getPageControlLayout(page));
} else if (cmd === 'controls') {
  console.log(doc.getControls());
} else if (cmd === 'info') {
  // node eng.mjs pkg doc info "4,5,10" "4:0,4:1,5:0,10:0,10:1"
  for (const p of pageArg.split(',')) {
    let text = ''; try { text = doc.getTextRange ? doc.getTextRange(0, +p, 0, doc.getParagraphLength(0, +p)) : ''; } catch { /* 무시 */ }
    console.log(`PARA ${p} len=${doc.getParagraphLength(0, +p)} text=${JSON.stringify(text)}`);
    console.log('  ', doc.getParaPropertiesAt(0, +p));
  }
  for (const s of (process.argv[6] || '').split(',').filter(Boolean)) {
    const [p, c] = s.split(':').map(Number);
    try { console.log(`SHAPE ${s}`, doc.getShapeProperties(0, p, c), 'bbox', doc.getShapeBBox(0, p, c)); } catch (e) { console.log(`SHAPE ${s} 오류`, String(e)); }
  }
} else if (cmd === 'all') {
  // 모든 쪽의 글자·개체 배치를 한 줄씩 출력 (엔진 비교용)
  const n = doc.pageCount();
  console.log('PAGES', n);
  for (let p = 0; p < n; p++) {
    const svg = doc.renderPageSvg(p);
    const rows = new Map();
    for (const m of svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>([^<]*)<\/text>/g)) {
      const y = Math.round(+m[2]); if (!rows.has(y)) rows.set(y, []); rows.get(y).push([+m[1], m[3]]);
    }
    for (const [y, list] of [...rows].sort((a, b) => a[0] - b[0])) {
      list.sort((a, b) => a[0] - b[0]);
      console.log(`p${p} T ${y} ${Math.round(list[0][0])} ${list.map((x) => x[1]).join('')}`);
    }
    for (const c of JSON.parse(doc.getPageControlLayout(p)).controls) {
      console.log(`p${p} C ${c.type} ${c.paraIdx}:${c.controlIdx} y=${c.y} h=${c.h} x=${c.x} w=${c.w}`);
    }
  }
} else if (cmd === 'pages') {
  console.log(doc.pageCount());
}
