// 한글 문서(.hwpx)를 워드 편집 화면용 HTML로 바꾸는 모듈 (한글 → 워드 저장에 쓴다)
// 글자 모양(글꼴·크기·색·진하게·기울임·밑줄·취소선·음영·자간·첨자), 문단 모양(정렬·줄 간격·
// 여백·들여쓰기·쪽 나누기), 표(칸 합치기·너비·배경·테두리·안쪽 여백·세로 정렬), 그림,
// 글상자, 머리말·꼬리말(쪽 번호 포함), 용지 설정을 살린다.
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const UNIT2MM = 25.4 / 7200; // 한글 단위(1/7200인치) → mm
const UNIT2PX = 96 / 7200;
const UNIT2PT = 1 / 100;
const MAX_IMG_W = 600;
const MIME = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', bmp: 'bmp' };
const r2 = (v) => Math.round(v * 100) / 100;
const WORD_SINGLE = 1.3; // 워드 "1줄"은 글자 크기의 약 1.3배 (docx-import의 WORD_LINE과 같은 값)

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function imgTag(bytes, ext, w, h) {
  const mime = MIME[(ext || '').toLowerCase()];
  if (!mime || !bytes?.length) return '';
  let width = Math.round(w); let height = Math.round(h);
  if (width > MAX_IMG_W) { height = Math.round(height * (MAX_IMG_W / width)); width = MAX_IMG_W; }
  const size = width > 0 && height > 0 ? ` width="${width}" height="${height}"` : '';
  return `<img src="data:image/${mime};base64,${toBase64(bytes)}"${size}>`;
}

const color = (v) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v.toLowerCase() : null);
// 한글은 음수 위치를 32비트 부호 없는 수로 적는다
const signed = (v) => { const n = +v || 0; return n > 0x7fffffff ? n - 0x100000000 : n; };

// WMF 그림(브라우저·워드 내보내기 모두 못 그림)에서 첫 번째 칠하기 색을 찾는다 (배경 띠 색으로 쓴다)
function wmfFill(bytes) {
  if (!bytes || bytes.length < 40) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = dv.getUint32(0, true) === 0x9ac6cdd7 ? 22 : 0;
  p += dv.getUint16(p + 2, true) * 2; // 머리 크기(워드 단위)
  while (p + 6 <= bytes.length) {
    const size = dv.getUint32(p, true) * 2; const fn = dv.getUint16(p + 4, true);
    if (size < 6 || fn === 0) break;
    if (fn === 0x02fc && p + 12 <= bytes.length && dv.getUint16(p + 6, true) === 0) { // CreateBrushIndirect, 단색
      const hex = [bytes[p + 8], bytes[p + 9], bytes[p + 10]].map((x) => x.toString(16).padStart(2, '0')).join('');
      if (hex !== 'ffffff') return `#${hex}`;
    }
    p += size;
  }
  return null;
}

// 글자 모양 → span
function span(text, st) {
  if (!text) return '';
  if (!st) return text;
  const css = [];
  if (st.size) css.push(`font-size:${st.size}pt`);
  if (st.color && st.color !== '#000000') css.push(`color:${st.color}`);
  if (st.font) css.push(`font-family:'${st.font.replace(/['"\\;<>]/g, '')}'`);
  if (st.bold) css.push('font-weight:bold');
  if (st.italic) css.push('font-style:italic');
  const deco = [st.underline && 'underline', st.strike && 'line-through'].filter(Boolean).join(' ');
  if (deco) css.push(`text-decoration:${deco}`);
  if (st.shade) css.push(`background-color:${st.shade}`);
  if (st.spacing) css.push(`letter-spacing:${r2((st.size || 10) * st.spacing / 100)}pt`);
  // 첨자: 화면에서는 1/1.2 크기 ('smaller'는 부모 기준이라 값을 직접 적는다). 워드로 낼 때 1.2배로 되돌린다.
  if (st.sup || st.sub) css.push(`vertical-align:${st.sup ? 'super' : 'sub'}`, `font-size:${r2((st.size || 10) / 1.2)}pt`);
  return css.length ? `<span style="${css.join(';')}">${text}</span>` : text;
}

function pageInfo(w, h, landscape, l, r, t, b) {
  const wide = landscape || w > h;
  const mm = (v) => Math.min(80, Math.max(5, Math.round(v * UNIT2MM * 100) / 100));
  return { orient: wide ? 'landscape' : 'portrait', m: { t: mm(t), b: mm(b), l: mm(l), r: mm(r) } };
}

/* ---------- .hwpx (XML 묶음 형식) ---------- */
const kids = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
const kid = (el, name) => kids(el, name)[0];
const all = (el, name) => (el ? [...el.getElementsByTagName('*')].filter((c) => c.localName === name) : []);
const num = (el, name) => +(el?.getAttribute(name) || 0) || 0;
const HWPX_ALIGN = { JUSTIFY: 'justify', LEFT: 'left', RIGHT: 'right', CENTER: 'center', DISTRIBUTE: 'justify', DISTRIBUTE_SPACE: 'justify' };
const LINE_STYLE = { SOLID: 'solid', DASH: 'dashed', DOT: 'dotted', DASH_DOT: 'dashed', DASH_DOT_DOT: 'dashed', LONG_DASH: 'dashed', DOUBLE_SLIM: 'double', SLIM_THICK: 'double', THICK_SLIM: 'double', SLIM_THICK_SLIM: 'double', CIRCLE: 'dotted' };

// 문단 모양(paraPr) → CSS
function paraCss(p) {
  if (!p) return { align: 'left', css: '' };
  const css = [];
  const align = HWPX_ALIGN[all(p, 'align')[0]?.getAttribute('horizontal')] || 'left';
  if (align !== 'left') css.push(`text-align:${align}`);
  // 같은 값이 <hp:switch>의 case(실제 단위)와 default(옛 단위)에 두 번 있다 → 앞의 것을 쓴다
  const mg = all(p, 'margin')[0];
  const v = (n) => num(kid(mg, n), 'value') * UNIT2PT;
  if (mg) {
    if (v('left')) css.push(`margin-left:${r2(v('left'))}pt`);
    if (v('right')) css.push(`margin-right:${r2(v('right'))}pt`);
    if (v('intent')) css.push(`text-indent:${r2(v('intent'))}pt`);
    css.push(`margin-top:${r2(v('prev'))}pt`, `margin-bottom:${r2(v('next'))}pt`);
  }
  const ls = all(p, 'lineSpacing')[0];
  let lr = '';
  if (ls) {
    const type = ls.getAttribute('type'); const val = num(ls, 'value');
    if (type === 'PERCENT' && val) css.push(`line-height:${val / 100}`);
    else if (type === 'FIXED' && val) css.push(`line-height:${r2(val * UNIT2PT)}pt`);
    else if (type === 'AT_LEAST' && val) { css.push(`line-height:${r2(val * UNIT2PT)}pt`); lr = 'atLeast'; }
    else if (type === 'BETWEEN_LINES') css.push(`line-height:calc(1em + ${r2(val * UNIT2PT)}pt)`);
  }
  const pageBreak = all(p, 'breakSetting')[0]?.getAttribute('pageBreakBefore') === '1';
  return { align, css: css.join(';'), lr, pageBreak };
}

function borderCss(bf) {
  if (!bf) return '';
  const css = [];
  for (const side of ['left', 'right', 'top', 'bottom']) {
    const b = kid(bf, `${side}Border`);
    const type = b?.getAttribute('type') || 'NONE';
    if (type === 'NONE' || !LINE_STYLE[type]) { css.push(`border-${side}:none`); continue; }
    const mm = parseFloat(b.getAttribute('width')) || 0.12;
    const px = Math.max(1, Math.round((mm / 25.4) * 96 * 10) / 10);
    css.push(`border-${side}:${px}px ${LINE_STYLE[type]} ${color(b.getAttribute('color')) || '#000000'}`);
  }
  const face = color(all(bf, 'winBrush')[0]?.getAttribute('faceColor'));
  if (face) css.push(`background-color:${face}`);
  return css.join(';');
}

export async function hwpxToDoc(zip) {
  const xml = async (path) => {
    const f = zip.file(path);
    return f ? new DOMParser().parseFromString(await f.async('string'), 'application/xml') : null;
  };
  const head = await xml('Contents/header.xml');
  const fonts = {}; const chars = {}; const paras = {}; const fills = {};
  if (head) {
    for (const ff of all(head, 'fontface')) {
      if (ff.getAttribute('lang') !== 'HANGUL') continue;
      for (const f of kids(ff, 'font')) fonts[f.getAttribute('id')] = f.getAttribute('face');
    }
    for (const c of all(head, 'charPr')) {
      const u = kid(c, 'underline')?.getAttribute('type');
      const s = kid(c, 'strikeout')?.getAttribute('shape');
      const shade = color(c.getAttribute('shadeColor'));
      chars[c.getAttribute('id')] = {
        size: (+c.getAttribute('height') || 1000) / 100,
        color: color(c.getAttribute('textColor')),
        font: fonts[kid(c, 'fontRef')?.getAttribute('hangul')],
        bold: !!kid(c, 'bold'), italic: !!kid(c, 'italic'),
        underline: !!u && u !== 'NONE', strike: !!s && s !== 'NONE' && s !== '3D',
        sup: !!kid(c, 'supscript'), sub: !!kid(c, 'subscript'),
        shade: shade && shade !== '#ffffff' ? shade : null,
        spacing: num(kid(c, 'spacing'), 'hangul'),
      };
    }
    for (const p of all(head, 'paraPr')) paras[p.getAttribute('id')] = paraCss(p);
    for (const b of all(head, 'borderFill')) fills[b.getAttribute('id')] = b;
  }

  // 그림 파일 찾기
  const bins = {};
  zip.forEach((path, f) => {
    const m = /^BinData\/([^/]+)\.(\w+)$/i.exec(path);
    if (m) bins[m[1]] = { f, ext: m[2] };
  });
  const images = {};
  await Promise.all(Object.entries(bins).map(async ([id, b]) => { images[id] = { bytes: await b.f.async('uint8array'), ext: b.ext }; }));
  // WMF(단순 도형 그림)는 PNG로 그려 둔다. 못 그리면 원본을 남겨 배경 색만이라도 쓴다.
  const { wmfToPng } = await import('./wmf.js');
  await Promise.all(Object.values(images).map(async (im) => {
    if (!/^wmf$/i.test(im.ext)) return;
    try {
      const png = await wmfToPng(im.bytes);
      if (png) { im.wmf = im.bytes; im.bytes = png; im.ext = 'png'; }
    } catch { /* 못 그린 그림은 건너뛴다 */ }
  }));

  const hf = { header: '', footer: '', pageNum: null };

  // 개체 위치(글자처럼 취급인지, 기준과 거리, 배치 방식, 크기)
  function posOf(node) {
    const pos = kid(node, 'pos'); const sz = kid(node, 'sz') || kid(node, 'curSz');
    return {
      asChar: pos?.getAttribute('treatAsChar') === '1',
      vrel: pos?.getAttribute('vertRelTo') || 'PARA', voff: signed(pos?.getAttribute('vertOffset')),
      hrel: pos?.getAttribute('horzRelTo') || 'COLUMN', hoff: signed(pos?.getAttribute('horzOffset')),
      wrap: node.getAttribute('textWrap') || 'TOP_AND_BOTTOM',
      w: num(sz, 'width'), h: num(sz, 'height'),
    };
  }
  const imageOf = (pic) => images[all(pic, 'img')[0]?.getAttribute('binaryItemIDRef')];

  function picHtml(pic, opt = {}) {
    const im = imageOf(pic);
    if (!im) return '';
    const ps = posOf(pic);
    // 같은 문단에 자리 잡힌 표와 겹쳐 놓인 그림: 한글에서는 표 글자를 밀지 않으므로 워드에서는 글 뒤에 깐다
    if (opt.overTable && (ps.wrap === 'SQUARE' || ps.wrap === 'TIGHT' || ps.wrap === 'THROUGH')) ps.wrap = 'BEHIND_TEXT';
    const sz = kid(pic, 'curSz') || kid(pic, 'sz') || kid(pic, 'orgSz');
    const w = (num(sz, 'width') || ps.w) * UNIT2PX; const h = (num(sz, 'height') || ps.h) * UNIT2PX;
    if (ps.asChar) return imgTag(im.bytes, im.ext, w, h);
    // 글 위·뒤에 떠 있는 그림: 워드에서도 같은 자리에 떠 있게 위치를 적어 둔다 (크기는 줄이지 않는다)
    const mime = MIME[(im.ext || '').toLowerCase()];
    if (!mime) return '';
    return `<img src="data:image/${mime};base64,${toBase64(im.bytes)}" width="${Math.round(w)}" height="${Math.round(h)}"`
      + ` data-float="${ps.wrap}" data-hrel="${ps.hrel}" data-hoff="${ps.hoff}" data-vrel="${ps.vrel}" data-voff="${ps.voff}">`;
  }

  function tableHtml(tbl) {
    const total = num(kid(tbl, 'sz'), 'width');
    const tcss = ['table-layout:fixed'];
    if (total) tcss.push(`width:${Math.round(total * UNIT2PX)}px`);
    // 쪽 기준으로 자리를 잡은 표는 워드에서도 같은 자리에 둔다
    const ps = posOf(tbl);
    const fl = !ps.asChar && /^(PAGE|PAPER)$/.test(ps.vrel)
      ? ` data-vrel="${ps.vrel}" data-voff="${ps.voff}" data-hrel="${ps.hrel}" data-hoff="${ps.hoff}"` : '';
    let html = `<table style="${tcss.join(';')}"${fl}><tbody>`;
    let spanUntil = -1; // 위에서 시작해 아래로 합쳐진 칸이 덮는 마지막 줄
    for (const [ri, tr] of kids(tbl, 'tr').entries()) {
      // 칸마다 글이 한 줄 이하인 줄은 한글의 칸 높이를 그대로(고정) 쓴다. 글꼴이 달라도 표 크기가 같게.
      // (여러 줄인 칸, 그리고 위 줄에서 합쳐 내려온 칸이 지나가는 줄은 워드가 늘려야 하므로 "최소 높이"로 둔다)
      const oneLine = ri > spanUntil && kids(tr, 'tc').every((tc) => {
        const sub = kid(tc, 'subList');
        return all(sub, 'lineseg').length <= 1 && !all(sub, 'tbl').length && !all(sub, 'pic').length;
      });
      for (const tc of kids(tr, 'tc')) {
        const rs = num(kid(tc, 'cellSpan'), 'rowSpan');
        if (rs > 1 && all(kid(tc, 'subList'), 'lineseg').length > 1) spanUntil = Math.max(spanUntil, ri + rs - 1);
      }
      html += oneLine ? '<tr data-exact="1">' : '<tr>';
      for (const tc of kids(tr, 'tc')) {
        const sp = kid(tc, 'cellSpan'); const sz = kid(tc, 'cellSz'); const cm = kid(tc, 'cellMargin');
        let attrs = '';
        if (num(sp, 'colSpan') > 1) attrs += ` colspan="${num(sp, 'colSpan')}"`;
        if (num(sp, 'rowSpan') > 1) attrs += ` rowspan="${num(sp, 'rowSpan')}"`;
        const css = [];
        const w = num(sz, 'width');
        if (w) css.push(`width:${Math.round(w * UNIT2PX)}px`);
        const h = num(sz, 'height');
        if (h) css.push(`height:${Math.round(h * UNIT2PX)}px`);
        if (cm) css.push(`padding:${['top', 'right', 'bottom', 'left'].map((k) => `${r2(num(cm, k) * UNIT2PT)}pt`).join(' ')}`);
        const bc = borderCss(fills[tc.getAttribute('borderFillIDRef')]);
        if (bc) css.push(bc);
        const sub = kid(tc, 'subList');
        const va = sub?.getAttribute('vertAlign');
        if (va === 'CENTER') css.push('vertical-align:middle');
        if (va === 'BOTTOM') css.push('vertical-align:bottom');
        if (css.length) attrs += ` style="${css.join(';')}"`;
        html += `<td${attrs}>${(sub ? paragraphs(kids(sub, 'p'), { cell: true }) : '') || '<br>'}</td>`;
      }
      html += '</tr>';
    }
    return `${html}</tbody></table>`;
  }

  // 도형의 선과 칠하기
  function shapeLook(node) {
    const ls = kid(node, 'lineShape');
    const type = ls?.getAttribute('style');
    const line = type && type !== 'NONE' && LINE_STYLE[type]
      ? { px: Math.max(1, Math.round((num(ls, 'width') / 7200) * 96 * 10) / 10), style: LINE_STYLE[type], color: color(ls.getAttribute('color')) || '#000000' }
      : null;
    let fill = color(all(node, 'winBrush')[0]?.getAttribute('faceColor'));
    if (!fill) fill = color(all(all(node, 'gradation')[0], 'color')[0]?.getAttribute('value'));
    if (fill === '#ffffff') fill = null;
    return { line, fill };
  }

  // 글상자(도형 안 글). 테두리나 배경이 있으면 한 칸짜리 표로, 없으면 문단으로 옮긴다.
  function shapeText(node) {
    const subs = all(node, 'drawText').map((d) => kid(d, 'subList')).filter(Boolean);
    const inner = subs.map((s) => paragraphs(kids(s, 'p'), { cell: true })).join('');
    const text = subs.map((s) => s.textContent).join('').trim();
    if (!text && !inner.includes('<img')) {
      // 글 없는 상자: 글자처럼 놓인 것은 같은 크기의 빈 상자로, 떠 있는 것은 아래 꾸밈 단계에서 문단에 입힌다
      const ps = posOf(node); const look = shapeLook(node);
      if (!ps.asChar || (!look.line && !look.fill) || !ps.h) return { inline: '', block: '' };
      const css = [look.line ? `border:${look.line.px}px ${look.line.style} ${look.line.color}` : 'border:none'];
      if (look.fill) css.push(`background-color:${look.fill}`);
      css.push(`height:${Math.round(ps.h * UNIT2PX)}px`);
      const tw = ps.w ? `;width:${Math.round(ps.w * UNIT2PX)}px` : '';
      return { inline: '', block: `<table style="table-layout:fixed${tw}"><tbody><tr><td style="${css.join(';')}"><br></td></tr></tbody></table>` };
    }
    // 쪽 번호표 같은 아주 짧은 글은 그 자리에 글자로 넣는다
    if (text.length <= 4 && !inner.includes('<img') && !inner.includes('<table')) {
      const st = chars[all(subs[0], 'run')[0]?.getAttribute('charPrIDRef')];
      return { inline: `${span(esc(text), st)} `, block: '' };
    }
    const look = shapeLook(node);
    const css = [look.line ? `border:${look.line.px}px ${look.line.style} ${look.line.color}` : 'border:none'];
    if (look.fill) css.push(`background-color:${look.fill}`);
    if (!look.fill && !look.line) return { inline: '', block: inner };
    const w = num(kid(node, 'sz'), 'width');
    const tw = w ? `;width:${Math.round(w * UNIT2PX)}px` : '';
    return { inline: '', block: `<table style="table-layout:fixed${tw}"><tbody><tr><td style="${css.join(';')}">${inner}</td></tr></tbody></table>` };
  }

  function ctrlHtml(ctrl) {
    let inline = '';
    for (const c of ctrl.children) {
      const n = c.localName;
      if ((n === 'header' || n === 'footer') && !hf[n]) {
        const sub = kid(c, 'subList');
        if (sub) hf[n] = paragraphs(kids(sub, 'p'));
      } else if (n === 'autoNum' || n === 'newNum') {
        if (n === 'autoNum' && c.getAttribute('numType') === 'PAGE') inline += '<span data-field="page">1</span>';
      } else if (n === 'pageNum') {
        hf.pageNum = c.getAttribute('pos') || 'BOTTOM_CENTER';
      }
    }
    return inline;
  }

  // 글 뒤·앞에 떠 있는 글 없는 도형(배경 띠, 점선 답 칸 등)을 그 도형이 덮는 문단들의
  // 배경·테두리로 옮긴다. 문단 위치는 문서에 저장된 줄 배치(lineseg)로 안다.
  function decorations(list) {
    const geo = list.map((p) => {
      const segs = kids(kid(p, 'linesegarray'), 'lineseg');
      if (!segs.length) return null;
      const last = segs[segs.length - 1];
      return { top: num(segs[0], 'vertpos'), bottom: num(last, 'vertpos') + num(last, 'vertsize') };
    });
    const group = []; let g = 0;
    list.forEach((p, i) => {
      if (i > 0 && (p.getAttribute('pageBreak') === '1' || (geo[i] && geo[i - 1] && geo[i].top < geo[i - 1].top))) g += 1;
      group[i] = g;
    });
    const deco = list.map(() => ({}));
    list.forEach((p, i) => {
      if (!geo[i]) return;
      for (const run of kids(p, 'run')) {
        for (const node of run.children) {
          const name = node.localName;
          if (!['rect', 'ellipse', 'polygon', 'curve', 'pic'].includes(name)) continue;
          const ps = posOf(node);
          if (ps.asChar || ps.vrel !== 'PARA' || !['BEHIND_TEXT', 'IN_FRONT_OF_TEXT'].includes(ps.wrap)) continue;
          let look;
          if (name === 'pic') {
            const im = imageOf(node);
            if (!im || MIME[(im.ext || '').toLowerCase()]) continue; // 보통 그림은 떠 있는 그림으로 따로 옮긴다
            const fill = wmfFill(im.bytes);
            if (!fill) continue;
            look = { fill, line: null };
          } else {
            if (all(node, 'drawText').some((d) => d.textContent.trim())) continue;
            look = shapeLook(node);
          }
          if (!look.fill && !look.line) continue;
          const y0 = geo[i].top + ps.voff; const y1 = y0 + ps.h;
          for (let j = i; j < list.length && group[j] === group[i]; j++) {
            if (!geo[j]) continue;
            const mid = (geo[j].top + geo[j].bottom) / 2;
            if (mid < y0 || mid > y1) continue;
            if (look.fill && !deco[j].fill) deco[j].fill = look.fill;
            if (look.line && !deco[j].line) deco[j].line = look.line;
          }
        }
      }
    });
    return deco.map((d) => [
      d.fill && `background-color:${d.fill}`,
      d.line && `border:${d.line.px}px ${d.line.style} ${d.line.color}`,
    ].filter(Boolean).join(';'));
  }

  // 글만 있는 문단의 줄 높이(pt): 저장된 줄마다 (높이 + 줄 간격)의 평균
  function exactLine(p, lastInCell) {
    for (const run of kids(p, 'run')) {
      for (const c of run.children) {
        if (['tbl', 'pic', 'rect', 'ellipse', 'polygon', 'curve', 'arc', 'container', 'equation', 'ole', 'line'].includes(c.localName) && posOf(c).asChar) return null;
      }
    }
    const segs = kids(kid(p, 'linesegarray'), 'lineseg');
    if (!segs.length) return null;
    let total = 0;
    segs.forEach((s, i) => { total += num(s, 'vertsize') + (lastInCell && i === segs.length - 1 ? 0 : num(s, 'spacing')); });
    const pt = Math.round((total / segs.length) * UNIT2PT * 100) / 100;
    if (!(pt > 0)) return null;
    // 글자 크기: 줄의 글자 높이(textheight). 없으면 줄 높이
    const size = (num(segs[0], 'textheight') || num(segs[0], 'vertsize')) * UNIT2PT;
    return { pt, single: segs.length === 1, size };
  }

  function paragraphs(list, opt = {}) {
    let out = '';
    const decoCss = decorations(list);
    for (const [pi, p] of list.entries()) {
      const base = paras[p.getAttribute('paraPrIDRef')] || { align: 'left', css: '' };
      let css = base.css; let lr = base.lr;
      const lastInCell = opt.cell && pi === list.length - 1;
      // 줄 높이는 문서에 저장된 실제 줄 배치(lineseg)에서 구해 "고정 줄 간격"으로 옮긴다.
      // 한글은 표 칸의 마지막 줄 아래에는 줄 간격을 더하지 않으므로 그만큼 빼서 고르게 나눈다.
      const exact = exactLine(p, lastInCell);
      const setCss = (c, prop, val) => `${c.replace(new RegExp(`(^|;)${prop}:[^;]*`, 'g'), '')};${prop}:${val}`.replace(/^;+/, '');
      if (exact?.single) {
        // 한 줄 문단: 한글은 줄 간격을 글 "아래"에, 워드는 "위"에 둔다. 그래서 워드 "1줄"로 쓰고
        // 남는 간격은 문단 아래 여백으로 옮겨 글자 위치와 다음 문단 위치를 둘 다 맞춘다.
        const natural = exact.size * WORD_SINGLE;
        const extra = exact.pt - natural;
        if (extra >= 0) {
          const mb = parseFloat((/(?:^|;)margin-bottom:([\d.]+)pt/.exec(css) || [])[1] || 0);
          css = setCss(setCss(css, 'line-height', String(WORD_SINGLE)), 'margin-bottom', `${Math.round((mb + extra) * 100) / 100}pt`);
        } else css = setCss(css, 'line-height', `${exact.pt}pt`);
        lr = '';
      } else if (exact) { css = setCss(css, 'line-height', `${exact.pt}pt`); lr = ''; }
      else if (lastInCell && kids(kid(p, 'linesegarray'), 'lineseg').length <= 1 && /line-height:[\d.]+(;|$)/.test(css)) {
        css = css.replace(/line-height:[\d.]+/, 'line-height:1.3');
      }
      const pp = { ...base, lr, css: [css, decoCss[pi]].filter(Boolean).join(';') };
      let inline = ''; let blocks = 0;
      const open = () => `<p${pp.css ? ` style="${pp.css}"` : ''}${pp.lr ? ` data-lr="${pp.lr}"` : ''}>`;
      const flushPara = (force) => { if (inline || force) out += `${open()}${inline || '<br>'}</p>`; inline = ''; };
      // 한글의 쪽 나누기는 "이 문단 앞에서 쪽 나눔"이다 (빈 줄을 따로 만들지 않는다)
      if (p.getAttribute('pageBreak') === '1' || pp.pageBreak) out += '<div class="page-break" data-before="1" contenteditable="false"></div>';
      let lastSt = null;
      for (const run of kids(p, 'run')) {
        const st = chars[run.getAttribute('charPrIDRef')];
        lastSt = st;
        for (const node of run.children) {
          const name = node.localName;
          if (name === 't') {
            for (const n of node.childNodes) {
              if (n.nodeType === 3) inline += span(esc(n.data), st);
              else if (n.localName === 'lineBreak') inline += '<br>';
              else if (n.localName === 'tab') inline += span('\u00a0\u00a0\u00a0\u00a0', st);
              else if (n.localName === 'nbSpace' || n.localName === 'fwSpace') inline += span('\u00a0', st);
              else if (n.localName === 'hyphen') inline += span('-', st);
              else if (n.nodeType === 1 && n.textContent) inline += span(esc(n.textContent), st);
            }
          } else if (name === 'ctrl') {
            inline += ctrlHtml(node);
          } else if (name === 'tbl') {
            flushPara(false); out += tableHtml(node); blocks += 1;
          } else if (name === 'pic') {
            // 떠 있는 그림은 문단에 붙여 두되 글 흐름을 밀지 않는다(워드에서 같은 자리에 뜬다)
            const overTable = kids(p, 'run').some((r) => kids(r, 'tbl').some((t) => !posOf(t).asChar));
            inline += picHtml(node, { overTable });
          } else if (['rect', 'ellipse', 'polygon', 'curve', 'arc', 'container'].includes(name)) {
            const r = shapeText(node);
            inline += r.inline;
            if (r.block) { flushPara(false); out += r.block; blocks += 1; }
            for (const pic of all(node, 'pic')) inline += picHtml(pic);
          }
        }
      }
      // 빈 문단도 원래 글자 크기로 줄 높이를 지킨다 (떠 있는 그림만 든 문단도 빈 문단과 같다)
      const floatsOnly = inline && !inline.replace(/<img [^>]*data-float[^>]*>/g, '');
      if (floatsOnly && blocks === 0) {
        out += `<p style="${[pp.css, lastSt?.size && `font-size:${lastSt.size}pt`].filter(Boolean).join(';')}"${pp.lr ? ` data-lr="${pp.lr}"` : ''}>${inline}<br></p>`;
        continue;
      }
      if (!inline && blocks === 0 && lastSt?.size) {
        out += `<p style="${[pp.css, `font-size:${lastSt.size}pt`].filter(Boolean).join(';')}"${pp.lr ? ` data-lr="${pp.lr}"` : ''}><br></p>`;
        continue;
      }
      flushPara(blocks === 0);
    }
    return out;
  }

  let html = ''; let page = {};
  for (let i = 0; ; i++) {
    const sec = await xml(`Contents/section${i}.xml`);
    if (!sec) break;
    if (i > 0 && html) html += '<div class="page-break" contenteditable="false"></div>';
    html += paragraphs(kids(sec.documentElement, 'p'));
    if (i === 0) {
      const pp = all(sec, 'pagePr')[0]; const mg = pp && all(pp, 'margin')[0];
      if (pp && mg) {
        const g = (n) => num(mg, n);
        const land = /^(LANDSCAPE|NARROWLY)$/i.test(pp.getAttribute('landscape') || '');
        const w = num(pp, 'width'); const h = num(pp, 'height');
        page = pageInfo(land ? Math.max(w, h) : w, land ? Math.min(w, h) : h, land, g('left'), g('right'), g('top') + g('header'), g('bottom') + g('footer'));
        // 한글: 위쪽 여백 안쪽에서 머리말이 시작한다 → 워드의 "머리글 위치"는 위쪽 여백 값
        page.hf = { header: g('top') * UNIT2MM, footer: g('bottom') * UNIT2MM };
      }
    }
  }
  if (!html) throw new Error('본문을 찾지 못했습니다');
  // 바탕쪽(모든 쪽 뒤에 깔리는 그림)은 워드 머리글 안에 "글 뒤" 그림으로 넣어 쪽마다 나오게 한다
  for (let i = 0; i < 4; i++) {
    const mp = await xml(`Contents/masterpage${i}.xml`);
    if (!mp) break;
    const type = mp.documentElement.getAttribute('type') || 'BOTH';
    if (type !== 'BOTH' && i > 0) continue;
    const imgs = all(mp, 'pic').map((pic) => picHtml(pic)).filter((s) => s.includes('data-float')).join('');
    if (imgs) {
      // 머리말 첫 문단에 함께 붙인다(새 줄을 만들지 않게)
      hf.header = /^<p\b[^>]*>/.test(hf.header)
        ? hf.header.replace(/^<p\b[^>]*>/, (m) => m + imgs)
        : `<p style="font-size:1pt;line-height:1;margin:0">${imgs}</p>${hf.header}`;
      break;
    }
  }
  // 쪽 번호 위치만 정해 둔 문서는 꼬리말(또는 머리말)에 쪽 번호를 만든다
  if (hf.pageNum && !/data-field="page"/.test(hf.header + hf.footer)) {
    const pos = hf.pageNum;
    const align = /LEFT/.test(pos) ? 'left' : /RIGHT/.test(pos) ? 'right' : 'center';
    const p = `<p style="text-align:${align}"><span data-field="page">1</span></p>`;
    if (/^TOP/.test(pos)) hf.header += p; else hf.footer += p;
  }
  return { html, ...page, ...(hf.header || hf.footer ? { parts: { header: hf.header, footer: hf.footer } } : {}) };
}
