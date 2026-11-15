// 워드 문서(.docx)를 편집 화면용 HTML로 바꾸는 모듈
// 글자 모양(글꼴·크기·색·진하게·기울임·밑줄·취소선·형광펜·첨자), 문단 모양(정렬·줄 간격·
// 여백·들여쓰기), 제목, 목록, 표(칸 합치기·음영·너비), 그림, 쪽 나누기, 용지 설정을 살린다.

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const TWIP_PT = 1 / 20;
const EMU_PX = 1 / 9525;
const MAX_IMG_W = 600;
const MIME = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', bmp: 'bmp' };
// 워드의 "1줄"(글꼴 고유 줄 높이)은 화면(CSS)에서 글자 크기의 약 1.3배다.
// 불러올 때 곱하고 저장할 때 나누므로 왕복해도 값이 그대로 남는다.
export const WORD_LINE = 1.3;
const HIGHLIGHT = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000',
  darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000',
  darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff',
};

// 이름공간과 상관없이 자식 찾기
const kids = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
const kid = (el, name) => kids(el, name)[0] || null;
const attr = (el, name) => (el ? el.getAttributeNS(W, name) ?? el.getAttribute(`w:${name}`) : null);
const deep = (el, name) => (el ? [...el.getElementsByTagName('*')].filter((c) => c.localName === name) : []);

function onOff(el) {
  if (!el) return undefined;
  const v = attr(el, 'val');
  return !(v === '0' || v === 'false' || v === 'off');
}
function hexColor(v) {
  return v && /^[0-9a-f]{6}$/i.test(v) ? `#${v.toLowerCase()}` : null;
}

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/* ---------- 글자 모양 ---------- */
function readRPr(rPr, theme) {
  const o = {};
  if (!rPr) return o;
  const set = (k, v) => { if (v !== undefined && v !== null) o[k] = v; };
  set('b', onOff(kid(rPr, 'b')));
  set('i', onOff(kid(rPr, 'i')));
  set('strike', onOff(kid(rPr, 'strike')) || onOff(kid(rPr, 'dstrike')));
  const u = kid(rPr, 'u');
  if (u) o.u = attr(u, 'val') !== 'none';
  const c = kid(rPr, 'color');
  if (c) { const v = attr(c, 'val'); o.color = v === 'auto' ? null : hexColor(v); }
  const sz = kid(rPr, 'sz');
  if (sz && +attr(sz, 'val')) o.size = +attr(sz, 'val') / 2;
  const f = kid(rPr, 'rFonts');
  if (f) {
    const font = attr(f, 'eastAsia') || theme.font(attr(f, 'eastAsiaTheme'))
      || attr(f, 'ascii') || attr(f, 'hAnsi') || theme.font(attr(f, 'asciiTheme'));
    if (font) o.font = font;
  }
  const hl = kid(rPr, 'highlight');
  if (hl) o.bg = HIGHLIGHT[attr(hl, 'val')] || null;
  const shd = kid(rPr, 'shd');
  if (shd && !o.bg) { const v = hexColor(attr(shd, 'fill')); if (v) o.bg = v; }
  const va = kid(rPr, 'vertAlign');
  if (va) o.vert = attr(va, 'val');
  const vanish = onOff(kid(rPr, 'vanish'));
  if (vanish !== undefined) o.hidden = vanish;
  const caps = onOff(kid(rPr, 'caps'));
  if (caps !== undefined) o.caps = caps;
  return o;
}

function runCss(p) {
  const css = [];
  if (p.font) css.push(`font-family:'${p.font.replace(/['"\\;<>]/g, '')}'`);
  if (p.size) css.push(`font-size:${p.size}pt`);
  if (p.color) css.push(`color:${p.color}`);
  if (p.b) css.push('font-weight:bold');
  if (p.i) css.push('font-style:italic');
  const deco = [p.u && 'underline', p.strike && 'line-through'].filter(Boolean).join(' ');
  if (deco) css.push(`text-decoration:${deco}`);
  if (p.bg) css.push(`background-color:${p.bg}`);
  // 첨자는 화면에서 1/1.2 크기로 그린다 ('smaller'는 부모 기준이라 크기가 틀어지므로 값을 직접 적는다).
  // 저장할 때 1.2배로 되돌린다.
  if (p.vert === 'superscript' || p.vert === 'subscript') {
    css.push(`vertical-align:${p.vert === 'superscript' ? 'super' : 'sub'}`);
    css.push(`font-size:${Math.round(((p.size || 10) / 1.2) * 100) / 100}pt`);
  }
  if (p.caps) css.push('text-transform:uppercase');
  return css.join(';');
}

/* ---------- 문단 모양 ---------- */
function readPPr(pPr) {
  const o = {};
  if (!pPr) return o;
  const jc = kid(pPr, 'jc');
  if (jc) {
    const v = attr(jc, 'val');
    o.align = { center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify', left: 'left', start: 'left' }[v];
  }
  const sp = kid(pPr, 'spacing');
  if (sp) {
    const line = attr(sp, 'line'); const rule = attr(sp, 'lineRule') || 'auto';
    if (line && +line > 0) o.line = rule === 'auto' ? { ratio: +line / 240 } : { pt: +line * TWIP_PT, rule };
    if (attr(sp, 'before') !== null && attr(sp, 'beforeAutospacing') !== '1') o.before = +attr(sp, 'before') * TWIP_PT;
    if (attr(sp, 'after') !== null && attr(sp, 'afterAutospacing') !== '1') o.after = +attr(sp, 'after') * TWIP_PT;
  }
  const ind = kid(pPr, 'ind');
  if (ind) {
    const left = attr(ind, 'left') ?? attr(ind, 'start');
    if (left !== null) o.left = +left * TWIP_PT;
    const right = attr(ind, 'right') ?? attr(ind, 'end');
    if (right !== null) o.right = +right * TWIP_PT;
    if (attr(ind, 'firstLine') !== null) o.first = +attr(ind, 'firstLine') * TWIP_PT;
    if (attr(ind, 'hanging') !== null) o.first = -attr(ind, 'hanging') * TWIP_PT;
  }
  const shd = kid(pPr, 'shd');
  if (shd) { const v = hexColor(attr(shd, 'fill')); if (v) o.bg = v; }
  const pb = onOff(kid(pPr, 'pageBreakBefore'));
  if (pb !== undefined) o.pageBreak = pb;
  return o;
}

function paraCss(p) {
  const css = [];
  if (p.align && p.align !== 'left') css.push(`text-align:${p.align}`);
  // 줄 간격이 없으면 워드 기본값(1줄)이다. 편집 화면 기본값(1.6)이 끼어들지 않게 늘 적는다.
  if (p.line?.pt) css.push(`line-height:${Math.round(p.line.pt * 100) / 100}pt`);
  else css.push(`line-height:${Math.round((p.line?.ratio || 1) * WORD_LINE * 10000) / 10000}`);
  css.push(`margin-top:${Math.round((p.before || 0) * 100) / 100}pt`);
  css.push(`margin-bottom:${Math.round((p.after || 0) * 100) / 100}pt`);
  if (p.left) css.push(`margin-left:${Math.round(p.left * 10) / 10}pt`);
  if (p.right) css.push(`margin-right:${Math.round(p.right * 10) / 10}pt`);
  if (p.first) css.push(`text-indent:${Math.round(p.first * 10) / 10}pt`);
  if (p.bg) css.push(`background-color:${p.bg}`);
  return css.join(';');
}

/* ---------- 스타일 · 테마 · 목록 ---------- */
function readTheme(xml) {
  const map = {};
  if (xml) {
    for (const [kind, el] of [['minor', deep(xml, 'minorFont')[0]], ['major', deep(xml, 'majorFont')[0]]]) {
      if (!el) continue;
      const latin = kid(el, 'latin')?.getAttribute('typeface');
      const ea = kid(el, 'ea')?.getAttribute('typeface');
      const hang = kids(el, 'font').find((f) => f.getAttribute('script') === 'Hang')?.getAttribute('typeface');
      map[`${kind}EastAsia`] = hang || ea || latin;
      map[`${kind}HAnsi`] = latin; map[`${kind}Ascii`] = latin; map[`${kind}Bidi`] = latin;
    }
  }
  return { font: (name) => (name && map[name]) || null };
}

function readStyles(xml, theme) {
  const st = { rDefault: {}, pDefault: {}, byId: {}, defaultPara: null };
  if (!xml) return st;
  const dd = deep(xml, 'docDefaults')[0];
  st.rDefault = readRPr(deep(dd, 'rPr')[0], theme);
  st.pDefault = readPPr(deep(dd, 'pPr')[0]);
  for (const s of deep(xml, 'style')) {
    const id = attr(s, 'styleId');
    st.byId[id] = {
      type: attr(s, 'type'),
      name: (attr(kid(s, 'name'), 'val') || '').toLowerCase(),
      basedOn: attr(kid(s, 'basedOn'), 'val'),
      r: readRPr(kid(s, 'rPr'), theme),
      p: readPPr(kid(s, 'pPr')),
      numPr: kid(kid(s, 'pPr'), 'numPr'),
    };
    if (attr(s, 'type') === 'paragraph' && attr(s, 'default') === '1') st.defaultPara = id;
  }
  return st;
}

function styleChain(st, id) {
  const chain = [];
  for (let guard = 0; id && st.byId[id] && guard < 20; guard++) { chain.unshift(st.byId[id]); id = st.byId[id].basedOn; }
  return chain;
}

function readNumbering(xml) {
  const abs = {}; const nums = {};
  if (!xml) return { fmt: () => null };
  for (const a of deep(xml, 'abstractNum')) {
    const lv = {};
    for (const l of kids(a, 'lvl')) lv[+attr(l, 'ilvl')] = attr(kid(l, 'numFmt'), 'val') || 'decimal';
    abs[attr(a, 'abstractNumId')] = lv;
  }
  for (const n of deep(xml, 'num')) nums[attr(n, 'numId')] = attr(kid(n, 'abstractNumId'), 'val');
  return {
    fmt(numId, lvl) {
      const a = abs[nums[numId]];
      return a ? (a[lvl] || a[0] || 'decimal') : null;
    },
  };
}

/* ---------- 본문 ---------- */
export async function docxToDoc(zip) {
  const parse = async (p) => {
    const f = zip.file(p);
    return f ? new DOMParser().parseFromString(await f.async('string'), 'application/xml') : null;
  };
  const docXml = await parse('word/document.xml');
  if (!docXml) throw new Error('word/document.xml 없음');
  const theme = readTheme(await parse('word/theme/theme1.xml'));
  const st = readStyles(await parse('word/styles.xml'), theme);
  const numbering = readNumbering(await parse('word/numbering.xml'));

  // 그림 연결 정보
  const rels = {};
  const relXml = await parse('word/_rels/document.xml.rels');
  if (relXml) for (const r of deep(relXml, 'Relationship')) rels[r.getAttribute('Id')] = r.getAttribute('Target');
  const imgCache = {};
  async function imageUrl(rid) {
    const target = rels[rid];
    if (!target) return null;
    const p = target.startsWith('/') ? target.slice(1) : `word/${target}`.replace(/\/[^/]+\/\.\.\//g, '/');
    if (p in imgCache) return imgCache[p];
    const ext = (p.split('.').pop() || '').toLowerCase();
    const f = zip.file(p);
    imgCache[p] = f && MIME[ext] ? `data:image/${MIME[ext]};base64,${toBase64(await f.async('uint8array'))}` : null;
    return imgCache[p];
  }

  const out = document.implementation.createHTMLDocument('');
  const el = (tag, css) => { const e = out.createElement(tag); if (css) e.setAttribute('style', css); return e; };

  function paraProps(p) {
    const pPr = kid(p, 'pPr');
    const sid = attr(kid(pPr, 'pStyle'), 'val') || st.defaultPara;
    const chain = styleChain(st, sid);
    const props = Object.assign({}, st.pDefault, ...chain.map((s) => s.p), readPPr(pPr));
    const rBase = Object.assign({}, st.rDefault, ...chain.map((s) => s.r));
    const styleName = chain.length ? chain[chain.length - 1].name : '';
    let numPr = kid(pPr, 'numPr');
    if (!numPr) for (const s of chain) if (s.numPr) numPr = s.numPr;
    let list = null;
    if (numPr) {
      const numId = attr(kid(numPr, 'numId'), 'val');
      const lvl = +(attr(kid(numPr, 'ilvl'), 'val') || 0);
      const fmt = numId && numId !== '0' ? numbering.fmt(numId, lvl) : null;
      if (fmt && fmt !== 'none') list = { tag: fmt === 'bullet' ? 'ul' : 'ol', lvl: Math.min(lvl, 6) };
    }
    const heading = /^heading ([1-3])$/.exec(styleName) || /^제목 ([1-3])$/.exec(styleName);
    return { props, rBase, list, tag: heading ? `h${heading[1]}` : 'p' };
  }

  // 문단 안의 글자들을 target에 넣는다. 글상자 안 문단은 after에 모은다.
  // 쪽 번호 필드 자리
  const pageField = (css) => { const s = el('span', css); s.dataset.field = 'page'; s.textContent = '1'; return s; };

  async function inlines(node, target, rBase, after, state) {
    for (const c of node.children) {
      const n = c.localName;
      if (n === 'r') {
        const rPr = kid(c, 'rPr');
        const rs = attr(kid(rPr, 'rStyle'), 'val');
        const p = Object.assign({}, rBase, ...styleChain(st, rs).map((s) => s.r), readRPr(rPr, theme));
        if (p.hidden) continue;
        const css = runCss(p);
        let span = null;
        const text = (t) => {
          if (!t || state.skipField) return;
          if (!span) { span = el('span', css); target.append(span); }
          span.append(t);
        };
        for (const x of c.children) {
          const k = x.localName;
          // 필드(쪽 번호 등): 시작 → 명령 → 구분 → 결과 → 끝
          if (k === 'fldChar') {
            const t = attr(x, 'fldCharType');
            if (t === 'begin') state.field = '';
            else if (t === 'separate') {
              if (/^\s*PAGE\b/i.test(state.field || '')) { target.append(pageField(css)); span = null; state.skipField = true; }
            } else if (t === 'end') { state.field = null; state.skipField = false; }
            continue;
          }
          if (k === 'instrText') { if (state.field !== null && state.field !== undefined) state.field += x.textContent; continue; }
          if (k === 't') text(x.textContent);
          else if (k === 'tab' || k === 'ptab') text('\u00a0\u00a0\u00a0\u00a0');
          else if (k === 'noBreakHyphen') text('-');
          else if (k === 'sym') { const code = parseInt(attr(x, 'char') || '', 16); if (code) text(String.fromCharCode(code > 0xf000 ? code - 0xf000 : code)); }
          else if (k === 'br' || k === 'cr') {
            if (attr(x, 'type') === 'page') state.pageBreakAfter = true;
            else { target.append(out.createElement('br')); span = null; }
          } else if (k === 'drawing' || k === 'pict' || k === 'object' || k === 'AlternateContent') {
            span = null;
            await drawing(x, target, after);
          } else if (k === 'rPr') { /* 글자 모양은 위에서 읽었다 */ }
        }
      } else if (n === 'fldSimple' && /^\s*PAGE\b/i.test(attr(c, 'instr') || '')) {
        const rPr = kid(deep(c, 'r')[0], 'rPr');
        target.append(pageField(runCss(Object.assign({}, rBase, readRPr(rPr, theme)))));
      } else if (n === 'hyperlink' || n === 'ins' || n === 'smartTag' || n === 'fldSimple' || n === 'customXml' || n === 'dir' || n === 'bdo') {
        await inlines(c, target, rBase, after, state);
      } else if (n === 'sdt') {
        const content = kid(c, 'sdtContent');
        if (content) await inlines(content, target, rBase, after, state);
      } else if (n === 'AlternateContent') {
        await drawing(c, target, after);
      }
    }
  }

  async function drawing(x, target, after) {
    // 대체 내용이 있으면 첫 번째(최신 형식)를 쓴다
    if (x.localName === 'AlternateContent') {
      const choice = kid(x, 'Choice') || kid(x, 'Fallback');
      if (choice) for (const c of choice.children) await drawing(c, target, after);
      return;
    }
    const blip = deep(x, 'blip')[0];
    const vimg = deep(x, 'imagedata')[0];
    const rid = blip ? (blip.getAttributeNS(R_NS, 'embed') || blip.getAttribute('r:embed'))
      : vimg ? (vimg.getAttributeNS(R_NS, 'id') || vimg.getAttribute('r:id')) : null;
    if (rid) {
      const url = await imageUrl(rid);
      if (url) {
        const ext = deep(x, 'extent')[0];
        let w = ext ? Math.round(+ext.getAttribute('cx') * EMU_PX) : 0;
        let h = ext ? Math.round(+ext.getAttribute('cy') * EMU_PX) : 0;
        if (w > MAX_IMG_W) { h = Math.round(h * (MAX_IMG_W / w)); w = MAX_IMG_W; }
        const img = out.createElement('img');
        img.setAttribute('src', url);
        if (w > 0 && h > 0) { img.setAttribute('width', w); img.setAttribute('height', h); }
        target.append(img);
      }
    }
    // 글상자 안의 글은 문단 뒤에 이어 붙인다
    const box = deep(x, 'txbxContent')[0];
    if (box) await blocks(box, after);
  }

  async function paragraph(p, parent) {
    const info = paraProps(p);
    const node = el(info.list ? 'li' : info.tag, paraCss(info.props));
    if (info.props.line?.rule === 'atLeast') node.dataset.lr = 'atLeast';
    const after = out.createDocumentFragment();
    const state = { pageBreakAfter: false, field: null, skipField: false };
    await inlines(p, node, info.rBase, after, state);
    const empty = !node.textContent.trim() && !node.querySelector('img');
    // 쪽 나누기만 든 빈 문단은 쪽 나누기 하나로 바꾼다 (다시 저장해도 문단이 늘지 않게)
    const breakOnly = state.pageBreakAfter && empty && !node.querySelector('br');
    if (!node.childNodes.length) node.append(out.createElement('br'));
    // 빈 문단은 문단 기호의 글자 크기를 써서 줄 높이가 원본과 같게 한다
    const mark = Object.assign({}, info.rBase, readRPr(kid(kid(p, 'pPr'), 'rPr'), theme));
    const size = empty ? mark.size : info.rBase.size;
    if (size && (empty || !node.querySelector('span'))) node.style.fontSize = `${size}pt`;
    if (empty && mark.font) node.style.fontFamily = `'${mark.font.replace(/['"\\;<>]/g, '')}'`;
    return { node, list: info.list, pageBefore: info.props.pageBreak, pageAfter: state.pageBreakAfter, breakOnly, after };
  }

  function pageBreak() {
    const d = el('div'); d.className = 'page-break'; d.setAttribute('contenteditable', 'false'); return d;
  }

  async function table(tbl) {
    const t = el('table');
    const grid = kids(kid(tbl, 'tblGrid'), 'gridCol').map((g) => +attr(g, 'w') || 0);
    const total = grid.reduce((s, v) => s + v, 0);
    const body = el('tbody'); t.append(body);
    const origin = {}; // 칸 번호 → 세로로 합쳐지는 첫 칸
    for (const tr of kids(tbl, 'tr')) {
      const row = el('tr');
      let col = 0;
      const before = kid(kid(tr, 'trPr'), 'gridBefore');
      if (before) col += +attr(before, 'val') || 0;
      for (const tc of kids(tr, 'tc')) {
        const tcPr = kid(tc, 'tcPr');
        const span = +attr(kid(tcPr, 'gridSpan'), 'val') || 1;
        const vm = kid(tcPr, 'vMerge');
        if (vm && attr(vm, 'val') !== 'restart' && origin[col]) {
          origin[col].rowSpan += 1;
          col += span;
          continue;
        }
        const td = el('td');
        if (span > 1) td.colSpan = span;
        const css = [];
        if (total) css.push(`width:${Math.round((grid.slice(col, col + span).reduce((s, v) => s + v, 0) / total) * 1000) / 10}%`);
        const fill = hexColor(attr(kid(tcPr, 'shd'), 'fill'));
        if (fill) css.push(`background-color:${fill}`);
        const va = attr(kid(tcPr, 'vAlign'), 'val');
        if (va === 'center') css.push('vertical-align:middle');
        if (va === 'bottom') css.push('vertical-align:bottom');
        if (css.length) td.setAttribute('style', css.join(';'));
        await blocks(tc, td);
        if (!td.childNodes.length) td.append(out.createElement('br'));
        row.append(td);
        if (vm) origin[col] = td; else for (let k = col; k < col + span; k++) delete origin[k];
        col += span;
      }
      body.append(row);
    }
    return t;
  }

  // 문단·표를 parent에 차례로 넣는다 (목록은 묶어서 ul/ol로)
  async function blocks(container, parent) {
    let stack = []; // [{lvl, tag, el, lastLi}]
    const closeLists = () => { stack = []; };
    for (const c of container.children) {
      const n = c.localName;
      if (n === 'p') {
        const r = await paragraph(c, parent);
        if (r.pageBefore) { closeLists(); parent.append(pageBreak()); }
        if (r.breakOnly && !r.list) {
          closeLists();
          if (r.after.childNodes.length) parent.append(r.after);
          parent.append(pageBreak());
          continue;
        }
        if (r.list) {
          while (stack.length && (stack[stack.length - 1].lvl > r.list.lvl
            || (stack[stack.length - 1].lvl === r.list.lvl && stack[stack.length - 1].tag !== r.list.tag))) stack.pop();
          let top = stack[stack.length - 1];
          if (!top || top.lvl < r.list.lvl) {
            const listEl = el(r.list.tag);
            if (top && top.lastLi) top.lastLi.append(listEl); else parent.append(listEl);
            top = { lvl: r.list.lvl, tag: r.list.tag, el: listEl, lastLi: null };
            stack.push(top);
          }
          top.el.append(r.node);
          top.lastLi = r.node;
        } else {
          closeLists();
          parent.append(r.node);
        }
        if (r.after.childNodes.length) { closeLists(); parent.append(r.after); }
        if (r.pageAfter) { closeLists(); parent.append(pageBreak()); }
      } else if (n === 'tbl') {
        closeLists();
        parent.append(await table(c));
      } else if (n === 'sdt') {
        const content = kid(c, 'sdtContent');
        if (content) await blocks(content, parent);
      } else if (n === 'customXml' || n === 'ins') {
        await blocks(c, parent);
      }
    }
  }

  const bodyEl = deep(docXml, 'body')[0];
  const root = out.createElement('div');
  await blocks(bodyEl, root);
  // 표 바로 뒤에 글을 쓸 수 있도록 빈 문단을 둔다
  if (root.lastElementChild?.tagName === 'TABLE') root.append(el('p'));
  root.querySelectorAll('p:empty').forEach((p) => p.append(out.createElement('br')));

  // 용지 설정 (마지막 구역 기준)
  let page = {};
  const sect = kids(bodyEl, 'sectPr').pop() || deep(bodyEl, 'sectPr').pop();
  if (sect) {
    const sz = kid(sect, 'pgSz'); const mar = kid(sect, 'pgMar');
    const mm = (v) => Math.min(80, Math.max(5, Math.round(((+v || 0) / 1440) * 25.4 * 100) / 100));
    const landscape = attr(sz, 'orient') === 'landscape' || (+attr(sz, 'w') > +attr(sz, 'h'));
    if (mar) {
      page = { orient: landscape ? 'landscape' : 'portrait', m: { t: mm(attr(mar, 'top')), b: mm(attr(mar, 'bottom')), l: mm(attr(mar, 'left')), r: mm(attr(mar, 'right')) } };
      const d = (v) => Math.round(((+v || 0) / 1440) * 25.4 * 100) / 100;
      if (attr(mar, 'header') !== null) page.hf = { header: d(attr(mar, 'header')), footer: d(attr(mar, 'footer')) };
    } else page = { orient: landscape ? 'landscape' : 'portrait' };
  }

  // 머리글·바닥글 (기본 쪽 것). 편집 화면에는 안 보이지만 다시 저장할 때 그대로 넣는다.
  async function part(kind) {
    const refs = sect ? kids(sect, `${kind}Reference`) : [];
    const ref = refs.find((r) => attr(r, 'type') === 'default') || refs[0];
    const rid = ref && (ref.getAttributeNS(R_NS, 'id') || ref.getAttribute('r:id'));
    const target = rid && rels[rid];
    if (!target) return '';
    const path = target.startsWith('/') ? target.slice(1) : `word/${target}`;
    const px = await parse(path);
    if (!px) return '';
    // 머리글 안 그림은 머리글 자신의 연결 정보로 찾는다
    const own = await parse(path.replace(/([^/]+)$/, '_rels/$1.rels'));
    const saved = { ...rels };
    if (own) for (const r of deep(own, 'Relationship')) rels[r.getAttribute('Id')] = r.getAttribute('Target');
    const box = out.createElement('div');
    await blocks(px.documentElement, box);
    Object.keys(rels).forEach((k) => delete rels[k]); Object.assign(rels, saved);
    return box.textContent.trim() || box.querySelector('img') ? box.innerHTML : '';
  }
  const header = await part('header');
  const footer = await part('footer');
  return { html: root.innerHTML, ...page, ...(header || footer ? { parts: { header, footer } } : {}) };
}
