// 한글 문서(.hwp, .hwpx)를 편집 화면용 HTML로 바꾸는 모듈
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const UNIT2MM = 25.4 / 7200; // 한글 단위(1/7200인치) → mm
const UNIT2PX = 96 / 7200;
const MAX_IMG_W = 600;
const MIME = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', bmp: 'bmp' };

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

// 글자 모양 → span
function span(text, st) {
  if (!text) return '';
  if (!st) return text;
  const css = [];
  if (st.size && Math.abs(st.size - 10) > 0.01) css.push(`font-size:${st.size}pt`);
  if (st.color && st.color !== '#000000') css.push(`color:${st.color}`);
  if (st.font) css.push(`font-family:'${st.font.replace(/['"\\;<>]/g, '')}'`);
  if (st.bold) css.push('font-weight:bold');
  if (st.italic) css.push('font-style:italic');
  const deco = [st.underline && 'underline', st.strike && 'line-through'].filter(Boolean).join(' ');
  if (deco) css.push(`text-decoration:${deco}`);
  if (st.sup) css.push('vertical-align:super');
  if (st.sub) css.push('vertical-align:sub');
  return css.length ? `<span style="${css.join(';')}">${text}</span>` : text;
}

function para(inner, align) {
  const st = align && align !== 'left' ? ` style="text-align:${align}"` : '';
  return `<p${st}>${inner || '<br>'}</p>`;
}

function pageInfo(w, h, landscape, l, r, t, b) {
  const wide = landscape || w > h;
  const mm = (v) => Math.min(80, Math.max(5, Math.round(v * UNIT2MM)));
  return { orient: wide ? 'landscape' : 'portrait', m: { t: mm(t), b: mm(b), l: mm(l), r: mm(r) } };
}

/* ---------- .hwp (한글 5.0 이진 형식) ---------- */
const HWP_ALIGN = ['justify', 'left', 'right', 'center', 'justify', 'justify'];
const rgb = (c) => (Array.isArray(c) ? `#${c.map((v) => (v & 255).toString(16).padStart(2, '0')).join('')}` : null);

export async function hwpToDoc(buffer) {
  const { parse } = await import('./vendor/hwp.esm.js');
  const hwp = parse(new Uint8Array(buffer), { type: 'array' });
  const { info } = hwp;

  const charStyle = (idx) => {
    const cs = info.charShapes[idx];
    if (!cs) return null;
    const a = cs.attr >>> 0;
    return {
      size: Math.round(cs.fontBaseSize * 10) / 10,
      color: rgb(cs.color),
      font: info.fontFaces[cs.fontId[0]]?.name,
      italic: !!(a & 1), bold: !!(a & 2),
      underline: ((a >>> 2) & 3) === 1,
      strike: ((a >>> 18) & 7) !== 0,
      sup: !!(a & (1 << 15)), sub: !!(a & (1 << 16)),
    };
  };

  const isTable = (c) => c && Array.isArray(c.content) && typeof c.rowCount === 'number';
  const isShape = (c) => c && Array.isArray(c.content) && 'info' in c;

  function tableHtml(t) {
    const total = t.width || 1;
    let html = '<table style="table-layout:auto"><tbody>';
    for (const row of t.content) {
      if (!row) continue;
      html += '<tr>';
      for (const cell of row) {
        const at = cell.attribute || {};
        let attrs = '';
        if (at.colSpan > 1) attrs += ` colspan="${at.colSpan}"`;
        if (at.rowSpan > 1) attrs += ` rowspan="${at.rowSpan}"`;
        const css = [];
        if (at.width) css.push(`width:${Math.round((at.width / total) * 1000) / 10}%`);
        const bg = rgb(info.borderFills[(at.borderFillID || 0) - 1]?.backgroundColor);
        if (bg && bg !== '#ffffff') css.push(`background-color:${bg}`);
        if (css.length) attrs += ` style="${css.join(';')}"`;
        html += `<td${attrs}>${paragraphs(cell.items) || '<br>'}</td>`;
      }
      html += '</tr>';
    }
    return `${html}</tbody></table>`;
  }

  function paragraphs(list) {
    let out = '';
    for (const p of list || []) {
      const align = HWP_ALIGN[info.paragraphShapes[p.shapeIndex]?.align] || 'left';
      const shapes = [...(p.shapeBuffer || [])].sort((x, y) => x.pos - y.pos);
      let inline = ''; let run = ''; let cur = shapes[0]?.shapeIndex; let si = 0; let pos = 0; let ctrl = 0;
      const flushRun = () => { inline += span(esc(run), charStyle(cur)); run = ''; };
      const flushPara = (force) => { flushRun(); if (inline || force) out += para(inline, align); inline = ''; };
      let blocks = 0;
      for (const ch of p.content) {
        while (si + 1 < shapes.length && shapes[si + 1].pos <= pos) { flushRun(); si += 1; cur = shapes[si].shapeIndex; }
        if (typeof ch.value === 'string') { run += ch.value; pos += 1; continue; }
        if (ch.type === 0) { // 일반 제어 글자
          if (ch.value === 10) { flushRun(); inline += '<br>'; }
          pos += 1; continue;
        }
        pos += 8;
        if (ch.type === 1) { if (ch.value === 9) run += '\u00a0\u00a0\u00a0\u00a0'; continue; }
        const c = p.controls[ctrl]; ctrl += 1;
        if (isTable(c)) { flushPara(false); out += tableHtml(c); blocks += 1; } else if (isShape(c)) {
          if (c.info && typeof c.info.binID === 'number') {
            const bin = info.binData[c.info.binID];
            if (bin) { flushRun(); inline += imgTag(new Uint8Array(bin.payload), bin.extension, c.width * UNIT2PX, c.height * UNIT2PX); }
          } else {
            const inner = c.content.map((l) => paragraphs(l.items)).join('');
            if (inner) { flushPara(false); out += inner; blocks += 1; }
          }
        }
      }
      flushPara(blocks === 0);
    }
    return out;
  }

  const html = hwp.sections.map((s) => paragraphs(s.content)).join('');
  const s = hwp.sections[0] || {};
  const page = s.width
    ? pageInfo(s.width, s.height, s.orientation === 1, s.paddingLeft, s.paddingRight, s.paddingTop + (s.headerPadding || 0), s.paddingBottom + (s.footerPadding || 0))
    : {};
  return { html, ...page };
}

/* ---------- .hwpx (XML 묶음 형식) ---------- */
const kids = (el, name) => [...el.children].filter((c) => c.localName === name);
const kid = (el, name) => kids(el, name)[0];
const all = (el, name) => [...el.getElementsByTagName('*')].filter((c) => c.localName === name);
const HWPX_ALIGN = { JUSTIFY: 'justify', LEFT: 'left', RIGHT: 'right', CENTER: 'center', DISTRIBUTE: 'justify', DISTRIBUTE_SPACE: 'justify' };

export async function hwpxToDoc(zip) {
  const xml = async (path) => {
    const f = zip.file(path);
    return f ? new DOMParser().parseFromString(await f.async('string'), 'application/xml') : null;
  };
  const head = await xml('Contents/header.xml');
  const fonts = {}; const chars = {}; const paras = {};
  if (head) {
    for (const ff of all(head, 'fontface')) {
      if (ff.getAttribute('lang') !== 'HANGUL') continue;
      for (const f of kids(ff, 'font')) fonts[f.getAttribute('id')] = f.getAttribute('face');
    }
    for (const c of all(head, 'charPr')) {
      const u = kid(c, 'underline')?.getAttribute('type');
      const s = kid(c, 'strikeout')?.getAttribute('shape');
      const color = c.getAttribute('textColor');
      chars[c.getAttribute('id')] = {
        size: (+c.getAttribute('height') || 1000) / 100,
        color: /^#[0-9a-f]{6}$/i.test(color || '') ? color.toLowerCase() : null,
        font: fonts[kid(c, 'fontRef')?.getAttribute('hangul')],
        bold: !!kid(c, 'bold'), italic: !!kid(c, 'italic'),
        underline: !!u && u !== 'NONE', strike: !!s && s !== 'NONE',
        sup: !!kid(c, 'supscript'), sub: !!kid(c, 'subscript'),
      };
    }
    for (const p of all(head, 'paraPr')) {
      const al = all(p, 'align')[0]?.getAttribute('horizontal');
      paras[p.getAttribute('id')] = HWPX_ALIGN[al] || 'left';
    }
  }

  // 그림 파일 찾기
  const bins = {};
  zip.forEach((path, f) => {
    const m = /^BinData\/([^/]+)\.(\w+)$/i.exec(path);
    if (m) bins[m[1]] = { f, ext: m[2] };
  });
  const images = {};
  await Promise.all(Object.entries(bins).map(async ([id, b]) => { images[id] = { bytes: await b.f.async('uint8array'), ext: b.ext }; }));

  function picHtml(pic) {
    const ref = all(pic, 'img')[0]?.getAttribute('binaryItemIDRef');
    const im = images[ref];
    if (!im) return '';
    const sz = kid(pic, 'sz') || kid(pic, 'curSz') || kid(pic, 'orgSz');
    return imgTag(im.bytes, im.ext, (+sz?.getAttribute('width') || 0) * UNIT2PX, (+sz?.getAttribute('height') || 0) * UNIT2PX);
  }

  function tableHtml(tbl) {
    const total = +kid(tbl, 'sz')?.getAttribute('width') || 0;
    let html = '<table style="table-layout:auto"><tbody>';
    for (const tr of kids(tbl, 'tr')) {
      html += '<tr>';
      for (const tc of kids(tr, 'tc')) {
        const sp = kid(tc, 'cellSpan'); const sz = kid(tc, 'cellSz');
        let attrs = '';
        if (+sp?.getAttribute('colSpan') > 1) attrs += ` colspan="${+sp.getAttribute('colSpan')}"`;
        if (+sp?.getAttribute('rowSpan') > 1) attrs += ` rowspan="${+sp.getAttribute('rowSpan')}"`;
        const w = +sz?.getAttribute('width') || 0;
        if (w && total) attrs += ` style="width:${Math.round((w / total) * 1000) / 10}%"`;
        const sub = kid(tc, 'subList');
        html += `<td${attrs}>${(sub ? paragraphs(kids(sub, 'p')) : '') || '<br>'}</td>`;
      }
      html += '</tr>';
    }
    return `${html}</tbody></table>`;
  }

  function paragraphs(list) {
    let out = '';
    for (const p of list) {
      const align = paras[p.getAttribute('paraPrIDRef')] || 'left';
      let inline = ''; let blocks = 0;
      const flushPara = (force) => { if (inline || force) out += para(inline, align); inline = ''; };
      for (const run of kids(p, 'run')) {
        const st = chars[run.getAttribute('charPrIDRef')];
        for (const node of run.children) {
          const name = node.localName;
          if (name === 't') {
            for (const n of node.childNodes) {
              if (n.nodeType === 3) inline += span(esc(n.data), st);
              else if (n.localName === 'lineBreak') inline += '<br>';
              else if (n.localName === 'tab') inline += '\u00a0\u00a0\u00a0\u00a0';
              else if (n.nodeType === 1 && n.textContent) inline += span(esc(n.textContent), st);
            }
          } else if (name === 'tbl') { flushPara(false); out += tableHtml(node); blocks += 1; } else if (name === 'pic') inline += picHtml(node);
          else if (['rect', 'ellipse', 'polygon', 'container'].includes(name)) {
            const inner = all(node, 'subList').slice(0, 1).map((s) => paragraphs(kids(s, 'p'))).join('');
            if (inner) { flushPara(false); out += inner; blocks += 1; }
            for (const pic of kids(node, 'pic')) inline += picHtml(pic);
          }
        }
      }
      flushPara(blocks === 0);
    }
    return out;
  }

  let html = ''; let page = {};
  for (let i = 0; ; i++) {
    const sec = await xml(`Contents/section${i}.xml`);
    if (!sec) break;
    html += paragraphs(kids(sec.documentElement, 'p'));
    if (i === 0) {
      const pp = all(sec, 'pagePr')[0]; const mg = pp && all(pp, 'margin')[0];
      if (pp && mg) {
        const g = (n) => +mg.getAttribute(n) || 0;
        const land = /^(LANDSCAPE|NARROWLY)$/i.test(pp.getAttribute('landscape') || '');
        const w = +pp.getAttribute('width'); const h = +pp.getAttribute('height');
        page = pageInfo(land ? Math.max(w, h) : w, land ? Math.min(w, h) : h, land, g('left'), g('right'), g('top') + g('header'), g('bottom') + g('footer'));
      }
    }
  }
  if (!html) throw new Error('본문을 찾지 못했습니다');
  return { html, ...page };
}
