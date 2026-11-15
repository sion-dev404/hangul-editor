// 편집 화면(DOM)을 워드(.docx) 구조로 바꾸는 모듈
import {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell,
  WidthType, AlignmentType, HeadingLevel, PageBreak, PageOrientation, BorderStyle,
  LevelFormat, ShadingType, LineRuleType, Header, Footer, PageNumber, VerticalAlign, HeightRule,
  HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom, TextWrappingType, TableAnchorType, OverlapType,
} from 'docx';

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'auto' };
const BORDER_STYLE = { dashed: BorderStyle.DASHED, dotted: BorderStyle.DOTTED, double: BorderStyle.DOUBLE };
// 화면 선(CSS) → 워드 선. 굵기는 1/8pt 단위
function cssBorder(cs, side) {
  const cap = side[0].toUpperCase() + side.slice(1);
  const st = cs[`border${cap}Style`]; const w = parseFloat(cs[`border${cap}Width`]) || 0;
  if (st === 'none' || st === 'hidden' || !w) return null;
  return { style: BORDER_STYLE[st] || BorderStyle.SINGLE, size: Math.max(2, Math.round(w * 0.75 * 8)), color: hex(cs[`border${cap}Color`]) || '000000' };
}

import { WORD_LINE } from './docx-import.js';

const BLOCK = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'TABLE', 'HR', 'BLOCKQUOTE', 'PRE']);
const PX2TWIP = 15;
const mmTwip = (v) => Math.round((+v / 25.4) * 1440);
// 워드 형광펜 색 (이 색이면 음영 대신 형광펜으로 저장한다)
const HIGHLIGHT = {
  FFFF00: 'yellow', '00FF00': 'green', '00FFFF': 'cyan', FF00FF: 'magenta', '0000FF': 'blue', FF0000: 'red',
  '000080': 'darkBlue', '008080': 'darkCyan', '008000': 'darkGreen', '800080': 'darkMagenta', '800000': 'darkRed',
  '808000': 'darkYellow', '808080': 'darkGray', C0C0C0: 'lightGray', '000000': 'black',
};

function hex(rgb) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(rgb || '');
  if (!m || (m[4] !== undefined && parseFloat(m[4]) === 0)) return null;
  return [m[1], m[2], m[3]].map((v) => (+v).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function runStyle(el, root) {
  const cs = getComputedStyle(el);
  const st = {
    bold: parseInt(cs.fontWeight, 10) >= 600,
    italics: cs.fontStyle === 'italic',
    size: Math.round(parseFloat(cs.fontSize) * 0.75 * 2),
    font: cs.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, ''),
    color: hex(cs.color) || '000000',
  };
  if (cs.verticalAlign === 'super' || cs.verticalAlign === 'sub') {
    if (cs.verticalAlign === 'super') st.superScript = true; else st.subScript = true;
    // 화면에서는 첨자를 작게 그리지만 워드는 첨자를 스스로 줄이므로 원래 크기로 적는다
    // 화면의 'smaller'는 1/1.2배이므로 되돌린다
    st.size = Math.round(parseFloat(cs.fontSize) * 1.2 * 0.75 * 2);
  }
  for (let n = el; n && n !== root; n = n.parentElement) {
    const c = getComputedStyle(n);
    const deco = c.textDecorationLine || '';
    if (deco.includes('underline')) st.underline = {};
    if (deco.includes('line-through')) st.strike = true;
    // 문단 배경은 문단 음영으로 따로 저장하므로 글자 단위(인라인)에서만 본다
    if (!st.shading && !st.highlight && !BLOCK.has(n.tagName) && !['TD', 'TH', 'TR', 'TBODY'].includes(n.tagName)) {
      const bg = hex(c.backgroundColor);
      if (bg && HIGHLIGHT[bg]) st.highlight = HIGHLIGHT[bg];
      else if (bg) st.shading = { type: ShadingType.CLEAR, fill: bg, color: 'auto' };
    }
    if (['TD', 'TH'].includes(n.tagName) || BLOCK.has(n.tagName)) break;
  }
  return st;
}

function imageRun(img) {
  const m = /^data:image\/(png|jpeg|jpg|gif|bmp);base64,(.+)$/i.exec(img.getAttribute('src') || '');
  if (!m) return null;
  const bin = atob(m[2]);
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  const type = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  const fl = img.dataset.float;
  if (fl) {
    // 한글에서 떠 있던 그림: 같은 기준·거리로 띄운다 (한글 단위 1 = 127 EMU)
    const H = { PAPER: HorizontalPositionRelativeFrom.PAGE, PAGE: HorizontalPositionRelativeFrom.MARGIN, COLUMN: HorizontalPositionRelativeFrom.COLUMN, PARA: HorizontalPositionRelativeFrom.COLUMN };
    const V = { PAPER: VerticalPositionRelativeFrom.PAGE, PAGE: VerticalPositionRelativeFrom.MARGIN, PARA: VerticalPositionRelativeFrom.PARAGRAPH, COLUMN: VerticalPositionRelativeFrom.MARGIN };
    const wrap = { SQUARE: TextWrappingType.SQUARE, TOP_AND_BOTTOM: TextWrappingType.TOP_AND_BOTTOM, TIGHT: TextWrappingType.TIGHT, THROUGH: TextWrappingType.TIGHT }[fl] ?? TextWrappingType.NONE;
    return new ImageRun({
      type, data,
      transformation: { width: +img.getAttribute('width') || 100, height: +img.getAttribute('height') || 100 },
      floating: {
        horizontalPosition: { relative: H[img.dataset.hrel] || HorizontalPositionRelativeFrom.COLUMN, offset: Math.round((+img.dataset.hoff || 0) * 127) },
        verticalPosition: { relative: V[img.dataset.vrel] || VerticalPositionRelativeFrom.PARAGRAPH, offset: Math.round((+img.dataset.voff || 0) * 127) },
        behindDocument: fl === 'BEHIND_TEXT',
        allowOverlap: true,
        wrap: { type: wrap },
      },
    });
  }
  return new ImageRun({
    type, data,
    transformation: { width: img.offsetWidth || img.naturalWidth || 100, height: img.offsetHeight || img.naturalHeight || 100 },
  });
}

// 글자 흐름(인라인) 노드를 조각 목록으로 모은다
function collectInline(node, root, out) {
  if (node.nodeType === 3) {
    const text = node.data.replace(/[\n\r\t]+/g, ' ').replace(/ /g, ' ');
    if (text) out.push({ t: 'text', text, el: node.parentElement });
    return;
  }
  if (node.nodeType !== 1) return;
  if (node.tagName === 'BR') { out.push({ t: 'br' }); return; }
  if (node.dataset?.field === 'page') { out.push({ t: 'page', el: node }); return; }
  if (node.tagName === 'IMG') { out.push({ t: 'img', el: node }); return; }
  for (const c of node.childNodes) collectInline(c, root, out);
}

function makePara(nodes, blockEl, ctx, root) {
  const parts = [];
  for (const n of nodes) collectInline(n, root, parts);
  while (parts.length && parts[parts.length - 1].t === 'br') parts.pop();
  const children = [];
  for (const p of parts) {
    if (p.t === 'text') children.push(new TextRun({ text: p.text, ...runStyle(p.el, root) }));
    else if (p.t === 'br') children.push(new TextRun({ break: 1 }));
    else if (p.t === 'page') children.push(new TextRun({ children: [PageNumber.CURRENT], ...runStyle(p.el, root) }));
    else { const r = imageRun(p.el); if (r) children.push(r); }
  }
  const cs = getComputedStyle(blockEl);
  const fs = parseFloat(cs.fontSize) || 13.33;
  const spacing = {
    before: Math.round((parseFloat(cs.marginTop) || 0) * PX2TWIP),
    after: Math.round((parseFloat(cs.marginBottom) || 0) * PX2TWIP),
  };
  const own = blockEl.style.lineHeight || '';
  if (/pt$/.test(own)) {
    // 고정·최소 줄 간격 (pt로 적힌 값)
    spacing.line = Math.round(parseFloat(own) * 20);
    spacing.lineRule = blockEl.dataset.lr === 'atLeast' ? LineRuleType.AT_LEAST : LineRuleType.EXACT;
  } else {
    const lh = parseFloat(cs.lineHeight);
    spacing.line = Math.round(((Number.isFinite(lh) ? lh / fs : WORD_LINE) / WORD_LINE) * 240);
  }
  const align = { center: AlignmentType.CENTER, right: AlignmentType.RIGHT, end: AlignmentType.RIGHT, justify: AlignmentType.BOTH }[cs.textAlign] || AlignmentType.LEFT;
  const opt = {
    children,
    alignment: align,
    spacing,
    // 문단 기호의 글자 크기·글꼴: 글이 있으면 마지막 글자와 같게, 빈 줄이면 문단 자신의 크기로
    run: (() => {
      const last = [...parts].reverse().find((p) => p.t === 'text');
      const mcs = last ? getComputedStyle(last.el) : cs;
      const sz = parseFloat(mcs.fontSize) * (last && (mcs.verticalAlign === 'super' || mcs.verticalAlign === 'sub') ? 1.2 : 1);
      return { size: Math.round(sz * 0.75 * 2), font: mcs.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '') };
    })(),
  };
  const pbg = hex(cs.backgroundColor);
  if (pbg && !['TD', 'TH', 'LI'].includes(blockEl.tagName)) opt.shading = { type: ShadingType.CLEAR, fill: pbg, color: 'auto' };
  // 문단 테두리 (이어진 문단들이 같은 테두리면 워드가 하나의 상자로 묶어 그린다)
  if (!['TD', 'TH'].includes(blockEl.tagName)) {
    const b = {};
    for (const side of ['top', 'bottom', 'left', 'right']) { const v = cssBorder(cs, side); if (v) b[side] = { ...v, space: 4 }; }
    if (Object.keys(b).length) opt.border = b;
  }
  if (pendingBreak) { opt.pageBreakBefore = true; pendingBreak = false; }
  const head = { H1: HeadingLevel.HEADING_1, H2: HeadingLevel.HEADING_2, H3: HeadingLevel.HEADING_3 }[blockEl.tagName];
  if (head) opt.heading = head;
  if (ctx.list) {
    const level = Math.min(ctx.list.level, 4);
    if (ctx.list.ordered) opt.numbering = { reference: 'num', level, instance: ctx.list.instance };
    else opt.bullet = { level };
  } else if (ctx.indent > 0) {
    opt.indent = { left: Math.round(ctx.indent * PX2TWIP) };
  }
  return new Paragraph(opt);
}

let listInstance = 0;
let pendingBreak = false; // 다음 문단 앞에서 쪽을 나눈다

function listItems(listEl, level, out, root, instance) {
  const ordered = listEl.tagName === 'OL';
  for (const li of listEl.children) {
    if (li.tagName !== 'LI') continue;
    const inline = []; const nested = [];
    for (const c of li.childNodes) {
      if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) nested.push(c);
      else inline.push(c);
    }
    out.push(makePara(inline, li, { list: { ordered, level, instance }, indent: 0 }, root));
    for (const n of nested) listItems(n, level + 1, out, root, n.tagName === 'OL' ? ++listInstance : instance);
  }
}

// 칸 높이를 정해 둔 줄(한글 표)은 그 높이를 최소 높이로 지킨다. 여러 줄을 합친 칸은 빼고 본다.
function rowHeight(tr) {
  const hs = [...tr.cells].filter((c) => c.rowSpan === 1 && c.style.height).map((c) => parseFloat(c.style.height));
  if (!hs.length) return {};
  return { height: { value: Math.round(Math.min(...hs) * PX2TWIP), rule: tr.dataset.exact ? HeightRule.EXACT : HeightRule.ATLEAST } };
}

function makeTable(table, root) {
  // 칸의 실제 위치로 세로 격자선을 구한다 (한글·워드 모두 칸 너비 정보가 있어야 표를 제대로 읽는다)
  const raw = [];
  for (const tr of table.rows) for (const td of tr.cells) raw.push(td.offsetLeft, td.offsetLeft + td.offsetWidth);
  raw.sort((a, b) => a - b);
  const edges = [];
  for (const x of raw) if (!edges.length || x - edges[edges.length - 1] > 2) edges.push(x);
  if (edges.length < 2) edges.push((edges[0] || 0) + 100);
  const near = (x) => edges.reduce((best, e, i) => (Math.abs(e - x) < Math.abs(edges[best] - x) ? i : best), 0);
  const columnWidths = edges.slice(1).map((e, i) => Math.max(1, Math.round((e - edges[i]) * PX2TWIP)));

  const rows = [...table.rows].map((tr) => new TableRow({
    children: [...tr.cells].map((td) => {
      const kids = [];
      blocks(td, { indent: 0 }, kids, root);
      if (!kids.length || kids[kids.length - 1] instanceof Table) kids.push(new Paragraph({}));
      const a = near(td.offsetLeft);
      const span = Math.max(1, near(td.offsetLeft + td.offsetWidth) - a);
      const opt = {
        children: kids,
        width: { size: columnWidths.slice(a, a + span).reduce((s, v) => s + v, 0), type: WidthType.DXA },
      };
      if (span > 1) opt.columnSpan = span;
      if (td.rowSpan > 1) opt.rowSpan = td.rowSpan;
      const cs = getComputedStyle(td);
      const bg = hex(cs.backgroundColor);
      if (bg) opt.shading = { type: ShadingType.CLEAR, fill: bg, color: 'auto' };
      // 테두리: 칸마다 보이는 그대로 (없는 선은 없음으로)
      opt.borders = {};
      for (const side of ['top', 'bottom', 'left', 'right']) opt.borders[side] = cssBorder(cs, side) || NO_BORDER;
      // 안쪽 여백
      opt.margins = {
        top: Math.round(parseFloat(cs.paddingTop) * PX2TWIP) || 0,
        bottom: Math.round(parseFloat(cs.paddingBottom) * PX2TWIP) || 0,
        left: Math.round(parseFloat(cs.paddingLeft) * PX2TWIP) || 0,
        right: Math.round(parseFloat(cs.paddingRight) * PX2TWIP) || 0,
      };
      if (cs.verticalAlign === 'middle') opt.verticalAlign = VerticalAlign.CENTER;
      else if (cs.verticalAlign === 'bottom') opt.verticalAlign = VerticalAlign.BOTTOM;
      return new TableCell(opt);
    }),
    // 한글 표처럼 칸 높이를 정해 둔 줄은 그 높이를 최소 높이로 지킨다
    ...rowHeight(tr),
  }));
  const opt = {
    rows, columnWidths,
    width: { size: columnWidths.reduce((s, v) => s + v, 0), type: WidthType.DXA },
    // 선은 칸마다 적으므로 표 전체 기본 선은 없앤다 (없는 선이 그려지지 않게)
    borders: { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER, insideHorizontal: NO_BORDER, insideVertical: NO_BORDER },
  };
  // 한글에서 쪽 기준으로 자리를 잡았던 표 (한글 단위 5 = 1 twip)
  if (table.dataset.vrel) {
    const A = { PAPER: TableAnchorType.PAGE, PAGE: TableAnchorType.MARGIN };
    opt.float = {
      horizontalAnchor: A[table.dataset.hrel] || TableAnchorType.MARGIN,
      verticalAnchor: A[table.dataset.vrel] || TableAnchorType.MARGIN,
      absoluteHorizontalPosition: Math.round((+table.dataset.hoff || 0) / 5),
      absoluteVerticalPosition: Math.round((+table.dataset.voff || 0) / 5),
      overlap: OverlapType.NEVER,
    };
  }
  return new Table(opt);
}

function hasBlockChild(el) {
  return [...el.children].some((c) => BLOCK.has(c.tagName));
}

function blocks(container, ctx, out, root) {
  let inline = [];
  const flush = () => {
    if (inline.some((n) => n.nodeType !== 3 || n.data.trim())) out.push(makePara(inline, container, ctx, root));
    inline = [];
  };
  for (const n of container.childNodes) {
    if (n.nodeType === 3) { inline.push(n); continue; }
    if (n.nodeType !== 1) continue;
    const tag = n.tagName;
    if (!BLOCK.has(tag)) { inline.push(n); continue; }
    flush();
    if (tag === 'DIV' && n.classList.contains('page-break')) {
      // 한글에서 온 쪽 나누기는 다음 문단의 "앞에서 쪽 나눔"으로 (빈 문단이 다음 쪽으로 넘쳐 빈 쪽이 생기지 않게)
      const next = n.nextElementSibling;
      if (n.dataset.before && next && ['P', 'H1', 'H2', 'H3'].includes(next.tagName)) pendingBreak = true;
      else out.push(new Paragraph({ children: [new PageBreak()] }));
    } else if (tag === 'UL' || tag === 'OL') {
      listItems(n, 0, out, root, ++listInstance);
    } else if (tag === 'TABLE') {
      out.push(makeTable(n, root));
    } else if (tag === 'HR') {
      out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000', space: 1 } } }));
    } else {
      const cs = getComputedStyle(n);
      const indent = ctx.indent + (parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.paddingLeft) || 0);
      if (hasBlockChild(n)) blocks(n, { indent }, out, root);
      else out.push(makePara([...n.childNodes], n, { indent }, root));
    }
  }
  flush();
}

function partChildren(el) {
  const out = [];
  blocks(el, { indent: 0 }, out, el);
  if (!out.length || out[out.length - 1] instanceof Table) out.push(new Paragraph({}));
  return out;
}

// page: { name, orient, m: {t,b,l,r}(mm), header?: Element, footer?: Element, hf?: {header, footer}(mm) }
export async function exportDocx(editor, page) {
  listInstance = 0;
  pendingBreak = false;
  const children = partChildren(editor);
  const headers = page.header?.textContent.trim() || page.header?.querySelector('img')
    ? { default: new Header({ children: partChildren(page.header) }) } : undefined;
  const footers = page.footer?.textContent.trim() || page.footer?.querySelector('img')
    ? { default: new Footer({ children: partChildren(page.footer) }) } : undefined;
  const mm = mmTwip;
  const doc = new Document({
    creator: '한글 편집기',
    title: page.name,
    styles: { default: { document: { run: { font: '맑은 고딕', size: 20 } } } },
    numbering: {
      config: [{
        reference: 'num',
        levels: [0, 1, 2, 3, 4].map((l) => ({
          level: l, format: LevelFormat.DECIMAL, text: `%${l + 1}.`, alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 420 * (l + 1), hanging: 420 } } },
        })),
      }],
    },
    sections: [{
      properties: {
        page: {
          size: {
            width: 11906, height: 16838, // A4 (워드 기본값과 똑같은 수치)
            orientation: page.orient === 'landscape' ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
          },
          margin: {
            top: mm(page.m.t), bottom: mm(page.m.b), left: mm(page.m.l), right: mm(page.m.r),
            header: mm(page.hf?.header ?? 12.5), footer: mm(page.hf?.footer ?? 12.5),
          },
        },
      },
      headers, footers,
      children,
    }],
  });
  return Packer.toBlob(doc);
}
