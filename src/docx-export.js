// 편집 화면(DOM)을 워드(.docx) 구조로 바꾸는 모듈
import {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell,
  WidthType, AlignmentType, HeadingLevel, PageBreak, PageOrientation, BorderStyle,
  LevelFormat, ShadingType, convertMillimetersToTwip,
} from 'docx';

const BLOCK = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'TABLE', 'HR', 'BLOCKQUOTE', 'PRE']);
const PX2TWIP = 15;

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
  if (cs.verticalAlign === 'super') st.superScript = true;
  if (cs.verticalAlign === 'sub') st.subScript = true;
  for (let n = el; n && n !== root; n = n.parentElement) {
    const c = getComputedStyle(n);
    const deco = c.textDecorationLine || '';
    if (deco.includes('underline')) st.underline = {};
    if (deco.includes('line-through')) st.strike = true;
    if (!st.shading && !['TD', 'TH', 'TABLE', 'TR', 'TBODY'].includes(n.tagName)) {
      const bg = hex(c.backgroundColor);
      if (bg) st.shading = { type: ShadingType.CLEAR, fill: bg, color: 'auto' };
    }
    if (['TD', 'TH'].includes(n.tagName)) break;
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
    else { const r = imageRun(p.el); if (r) children.push(r); }
  }
  const cs = getComputedStyle(blockEl);
  const fs = parseFloat(cs.fontSize) || 13.33;
  const lh = parseFloat(cs.lineHeight);
  const ratio = Number.isFinite(lh) ? lh / fs : 1.6;
  const align = { center: AlignmentType.CENTER, right: AlignmentType.RIGHT, end: AlignmentType.RIGHT, justify: AlignmentType.BOTH }[cs.textAlign] || AlignmentType.LEFT;
  const opt = {
    children,
    alignment: align,
    spacing: {
      line: Math.round(ratio * 240),
      before: Math.round((parseFloat(cs.marginTop) || 0) * PX2TWIP),
      after: Math.round((parseFloat(cs.marginBottom) || 0) * PX2TWIP),
    },
  };
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

function makeTable(table, root) {
  const rows = [...table.rows].map((tr) => new TableRow({
    children: [...tr.cells].map((td) => {
      const kids = [];
      blocks(td, { indent: 0 }, kids, root);
      if (!kids.length || kids[kids.length - 1] instanceof Table) kids.push(new Paragraph({}));
      const opt = { children: kids };
      if (td.colSpan > 1) opt.columnSpan = td.colSpan;
      if (td.rowSpan > 1) opt.rowSpan = td.rowSpan;
      const bg = hex(getComputedStyle(td).backgroundColor);
      if (bg) opt.shading = { type: ShadingType.CLEAR, fill: bg, color: 'auto' };
      return new TableCell(opt);
    }),
  }));
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
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
      out.push(new Paragraph({ children: [new PageBreak()] }));
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

export async function exportDocx(editor, page) {
  listInstance = 0;
  const children = [];
  blocks(editor, { indent: 0 }, children, editor);
  if (!children.length || children[children.length - 1] instanceof Table) children.push(new Paragraph({}));
  const mm = convertMillimetersToTwip;
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
            width: mm(210), height: mm(297),
            orientation: page.orient === 'landscape' ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
          },
          margin: { top: mm(page.m.t), bottom: mm(page.m.b), left: mm(page.m.l), right: mm(page.m.r) },
        },
      },
      children,
    }],
  });
  return Packer.toBlob(doc);
}
