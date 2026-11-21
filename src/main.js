import './style.css';
import { initHwp, openHwp, showHwp, newDocument as newHwpDocument, offerRecovery, currentDoc as hwpCurrentDoc, markSavedCloud as hwpMarkSavedCloud } from './hwp-mode.js';
import * as cloud from './cloud.js';
import { icon } from './icons.js';
import { putRecovery, getRecovery, clock } from './recovery.js';
import { loadFontPack, injectFontCss, addKoglGroup } from './fonts.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const editor = $('#editor');
const page = $('#page');
const holder = $('#holder');
const guides = $('#guides');
const workspace = $('#workspace');

const MM = 96 / 25.4;
const MARGINS = {
  narrow: { t: 15, b: 15, l: 15, r: 15 },
  normal: { t: 20, b: 15, l: 30, r: 30 },
  wide: { t: 30, b: 30, l: 40, r: 40 },
  custom: { t: 20, b: 15, l: 30, r: 30 }, // 불러온 문서의 여백
};
const desktop = window.desktop || null; // 설치형(.exe)에서만 있음

function pageState() {
  return { orient: doc.orient, margin: doc.margin, m: MARGINS[doc.margin], parts: doc.parts, hf: doc.hf };
}
function applyPageState(s) {
  doc.parts = null; doc.hf = null;
  if (!s) return;
  // 머리글·바닥글(편집 화면에는 없지만 저장할 때 그대로 다시 넣는다)
  if (s.parts && (s.parts.header || s.parts.footer)) {
    doc.parts = { header: sanitize(String(s.parts.header || '')), footer: sanitize(String(s.parts.footer || '')) };
  }
  if (s.hf && Number.isFinite(+s.hf.header) && Number.isFinite(+s.hf.footer)) doc.hf = { header: +s.hf.header, footer: +s.hf.footer };
  if (s.orient === 'portrait' || s.orient === 'landscape') doc.orient = s.orient;
  const ok = s.m && ['t', 'b', 'l', 'r'].every((k) => Number.isFinite(+s.m[k]) && +s.m[k] >= 0 && +s.m[k] <= 100);
  if (s.margin === 'custom' || (!s.margin && ok)) {
    if (ok) { MARGINS.custom = { t: +s.m.t, b: +s.m.b, l: +s.m.l, r: +s.m.r }; doc.margin = 'custom'; }
  } else if (MARGINS[s.margin]) doc.margin = s.margin;
}
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48];
const COLORS = ['#000000', '#444444', '#888888', '#ffffff', '#c00000', '#ff0000', '#ffc000', '#ffff00', '#92d050', '#00b050', '#00b0f0', '#0070c0', '#002060', '#7030a0'];
const HILITES = ['transparent', '#ffff00', '#00ff00', '#00ffff', '#ff99cc', '#ffc000', '#d9d9d9'];
const CHARS = '※★☆●○◎◆◇■□▲△▼▽→←↑↓↔⇒♥♡♣♠♪☎✓✔✕°℃±×÷≠≤≥∞㎝㎜㎞㎏㎡％￦§「」『』【】〈〉《》·…①②③④⑤⑥⑦⑧⑨⑩㉠㉡㉢㉣㈜™©®';
const STORE = 'hangul-editor-doc';
const OWN_PART = 'hangulEditor/content.xml';
const EMPTY = '<p><br></p>';

const doc = { orient: 'portrait', margin: 'normal', zoom: 1, guides: true, parts: null, hf: null };
let savedRange = null;
let pendingPt = 10;

/* ---------- 공통 도구 ---------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

function sanitize(html) {
  const d = new DOMParser().parseFromString(html, 'text/html');
  d.querySelectorAll('script,style,iframe,object,embed,link,meta,form,input,button,textarea,select').forEach((e) => e.remove());
  d.querySelectorAll('*').forEach((e) => {
    for (const a of [...e.attributes]) {
      const n = a.name.toLowerCase();
      if (n.startsWith('on') || ((n === 'href' || n === 'src') && /^\s*javascript:/i.test(a.value))) e.removeAttribute(a.name);
    }
  });
  return d.body.innerHTML;
}

function setContent(html) {
  editor.innerHTML = html && html.trim() ? html : EMPTY;
  editor.querySelectorAll('td:empty, th:empty').forEach((c) => { c.innerHTML = '<br>'; });
}

/* ---------- 선택 영역 ---------- */
document.addEventListener('selectionchange', () => {
  const sel = getSelection();
  if (sel.rangeCount && editor.contains(sel.anchorNode)) {
    savedRange = sel.getRangeAt(0).cloneRange();
    refreshToolbar();
  }
});

function restoreSel() {
  const sel = getSelection();
  // 지금 선택 영역이 이미 글 안에 있으면 그대로 쓴다
  if (sel.rangeCount && editor.contains(sel.anchorNode) && document.activeElement === editor) {
    savedRange = sel.getRangeAt(0).cloneRange();
    return;
  }
  editor.focus({ preventScroll: true });
  if (savedRange && editor.contains(savedRange.startContainer)) {
    sel.removeAllRanges();
    sel.addRange(savedRange);
  } else {
    const r = document.createRange();
    r.selectNodeContents(editor); r.collapse(false);
    sel.removeAllRanges(); sel.addRange(r);
  }
}

function exec(cmd, val = null) {
  restoreSel();
  document.execCommand(cmd, false, val);
  changed();
}

/* ---------- 되돌리기 기록 ---------- */
const hist = { stack: [], i: -1, timer: null };
function record() {
  const h = editor.innerHTML;
  if (hist.stack[hist.i] === h) return;
  hist.stack.splice(hist.i + 1);
  hist.stack.push(h);
  if (hist.stack.length > 60) hist.stack.shift();
  hist.i = hist.stack.length - 1;
}
function flush() {
  clearTimeout(hist.timer);
  record();
  autosave();
}
// 브라우저가 문단 안에 목록·문단을 겹쳐 넣은 경우 바깥 문단을 풀어 준다
function normalize() {
  const bad = $$('p', editor).filter((p) => p.querySelector(':scope > ul, :scope > ol, :scope > p, :scope > table'));
  if (!bad.length) return;
  const sel = getSelection();
  const keep = sel.rangeCount && editor.contains(sel.anchorNode) ? [sel.anchorNode, sel.anchorOffset, sel.focusNode, sel.focusOffset] : null;
  bad.forEach((p) => p.replaceWith(...p.childNodes));
  if (keep && editor.contains(keep[0]) && editor.contains(keep[2])) {
    try { sel.setBaseAndExtent(...keep); savedRange = sel.getRangeAt(0).cloneRange(); } catch { /* 무시 */ }
  }
}

function changed() {
  fixFonts();
  normalize();
  if (!editor.firstChild) editor.innerHTML = EMPTY;
  clearTimeout(hist.timer);
  hist.timer = setTimeout(flush, 300);
  $('#saveState').textContent = '저장 중…';
  layout();
  refreshToolbar();
}
function step(d) {
  flush();
  const n = hist.i + d;
  if (n < 0 || n >= hist.stack.length) { toast(d < 0 ? '더 되돌릴 내용이 없습니다' : '다시 실행할 내용이 없습니다'); return; }
  hist.i = n;
  editor.innerHTML = hist.stack[n];
  savedRange = null;
  autosave(); layout();
}

function autosave() {
  const snap = { html: editor.innerHTML, name: $('#docName').value, ...pageState(), time: Date.now() };
  // 글이 많거나 그림이 큰 문서는 localStorage에 안 들어가므로 보관소(IndexedDB)에도 넣어 둔다
  try {
    localStorage.setItem(STORE, JSON.stringify(snap));
    $('#saveState').textContent = `자동 저장됨 ${clock()}`;
    return;
  } catch { /* 용량 초과면 아래 보관소로 */ }
  putRecovery('docx', snap).then((ok) => {
    $('#saveState').textContent = ok ? `자동 저장됨 ${clock()}` : '자동 저장 불가';
  });
}

/* ---------- 쪽 모양 ---------- */
function pageDims() {
  const m = MARGINS[doc.margin];
  const W = doc.orient === 'portrait' ? 210 : 297;
  const H = doc.orient === 'portrait' ? 297 : 210;
  return { m, W, H, per: (H - m.t - m.b) * MM };
}

let printStyle;
function applyPage() {
  const { m, W, per } = pageDims();
  page.style.width = `${W}mm`;
  page.style.padding = `${m.t}mm ${m.r}mm ${m.b}mm ${m.l}mm`;
  editor.style.minHeight = `${per}px`;
  if (!printStyle) { printStyle = document.createElement('style'); document.head.append(printStyle); }
  printStyle.textContent = `@page { size: A4 ${doc.orient}; margin: ${m.t}mm ${m.r}mm ${m.b}mm ${m.l}mm; }`;
  $$('[data-orient]').forEach((b) => b.classList.toggle('active', b.dataset.orient === doc.orient));
  $$('[data-margin]').forEach((b) => b.classList.toggle('active', b.dataset.margin === doc.margin));
  layout();
}

function layout() {
  const { m, per } = pageDims();
  const pages = Math.max(1, Math.ceil((editor.scrollHeight - 2) / per));
  page.style.minHeight = `${pages * per + (m.t + m.b) * MM}px`;
  guides.innerHTML = '';
  for (let k = 1; k < pages; k++) {
    const g = document.createElement('div');
    g.className = 'g';
    g.style.top = `${m.t * MM + per * k}px`;
    g.innerHTML = `<span>${k + 1}쪽</span>`;
    guides.append(g);
  }
  page.style.transform = `scale(${doc.zoom})`;
  holder.style.width = `${page.offsetWidth * doc.zoom}px`;
  holder.style.height = `${page.offsetHeight * doc.zoom}px`;
  const text = editor.innerText.replace(/\n/g, '');
  const all = [...text].length;
  const noSp = [...text.replace(/\s/g, '')].length;
  $('#stat').textContent = `${pages}쪽 · 글자 ${all}자 (공백 빼고 ${noSp}자)`;
  $('#zoomLabel').textContent = `${Math.round(doc.zoom * 100)}%`;
  $('#zoomSlider').value = String(Math.round(doc.zoom * 100));
  renderHF(pages, m);
}

// 함께 넣은 글꼴의 출처 표시 (공공누리 제1유형 조건)
function openFontCredits() {
  loadFontPack().then((pack) => {
    if (!pack) { toast('함께 넣은 글꼴이 없습니다'); return; }
    window.open(new URL('./fonts/kogl/출처표시.txt', location.href).href, '_blank');
  });
}

/* ---------- 머리말 · 꼬리말 ---------- */
// 화면에는 문서 맨 위(머리말)와 맨 아래(꼬리말) 여백에 미리 보여 주고, 눌러서 고친다.
// 저장할 때는 모든 쪽에 들어간다.
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const HF_FONT = "font-family:'맑은 고딕';font-size:10pt";

function renderHF(pages, m) {
  const parts = doc.parts;
  const hv = $('#hdrView'); const fv = $('#ftrView');
  const hd = doc.hf?.header ?? 12.5; const ft = doc.hf?.footer ?? 12.5;
  const fill = (el, html, num) => {
    el.hidden = !html;
    if (!html) return;
    el.innerHTML = html;
    el.querySelectorAll('[data-field="page"]').forEach((f) => { f.textContent = String(num); });
    el.style.padding = `0 ${m.r}mm 0 ${m.l}mm`;
  };
  fill(hv, parts?.header, 1);
  fill(fv, parts?.footer, pages);
  hv.style.top = `${Math.min(hd, Math.max(0, m.t - 5))}mm`;
  fv.style.bottom = `${Math.min(ft, Math.max(0, m.b - 5))}mm`;
}

// 저장된 머리말·꼬리말 HTML에서 대화 상자에 보일 값을 뽑는다
function parseHF(html) {
  const d = document.createElement('div');
  d.innerHTML = html || '';
  const out = { text: '', align: 'left', field: null, complex: !!d.querySelector('img,table') };
  for (const p of d.querySelectorAll('p')) {
    const align = p.style.textAlign || 'left';
    if (p.querySelector('[data-field="page"]')) {
      const t = p.textContent.trim();
      const style = /^-\s*\d+\s*-$/.test(t) ? 'dash' : /^\d+\s*쪽$/.test(t) ? 'of' : /^\d+$/.test(t) ? 'plain' : null;
      if (style) out.field = { align, style }; else out.complex = true;
    } else if (p.textContent.trim() && !out.text) {
      out.text = p.textContent.trim(); out.align = align;
    }
  }
  return out;
}

function buildHF(text, align, field) {
  const span = (t) => `<span style="${HF_FONT}">${escHtml(t)}</span>`;
  let html = '';
  if (text) html += `<p style="text-align:${align}">${span(text)}</p>`;
  if (field) {
    const n = `<span data-field="page" style="${HF_FONT}">1</span>`;
    const inner = field.style === 'dash' ? `${span('- ')}${n}${span(' -')}` : field.style === 'of' ? `${n}${span(' 쪽')}` : n;
    html += `<p style="text-align:${field.align}">${inner}</p>`;
  }
  return html;
}

let hfInit = null;
function openHF(focusNum) {
  const h = parseHF(doc.parts?.header); const f = parseHF(doc.parts?.footer);
  const fieldIn = f.field ? { where: 'footer', ...f.field } : h.field ? { where: 'header', ...h.field } : null;
  $('#hfHeader').value = h.text; $('#hfHeaderAlign').value = h.align;
  $('#hfFooter').value = f.text; $('#hfFooterAlign').value = f.align;
  $('#hfPageNum').checked = !!fieldIn || !!focusNum;
  $('#hfNumStyle').value = fieldIn?.style || 'plain';
  $('#hfNumPos').value = fieldIn ? `${fieldIn.where}-${fieldIn.align}` : 'footer-center';
  const note = $('#hfNote');
  note.hidden = !(h.complex || f.complex);
  note.textContent = '그림이나 표가 든 머리말·꼬리말은 여기서 글을 바꾸면 그림·표가 없어집니다. 바꾸지 않으면 그대로 둡니다.';
  hfInit = {
    header: $('#hfHeader').value + $('#hfHeaderAlign').value, footer: $('#hfFooter').value + $('#hfFooterAlign').value,
    num: hfNumKey(), numWhere: fieldIn?.where || null,
  };
  $('#hfDlg').hidden = false;
  (focusNum ? $('#hfNumPos') : $('#hfHeader')).focus();
}
const hfNumKey = () => `${$('#hfPageNum').checked}|${$('#hfNumStyle').value}|${$('#hfNumPos').value}`;

function applyHF() {
  const [where, align] = $('#hfNumPos').value.split('-');
  const field = $('#hfPageNum').checked ? { align, style: $('#hfNumStyle').value } : null;
  const hText = $('#hfHeader').value.trim(); const fText = $('#hfFooter').value.trim();
  // 번호 설정이 바뀌어도 번호와 상관없는 쪽(머리말/꼬리말)은 원래 내용을 그대로 둔다
  const numChanged = hfNumKey() !== hfInit.num;
  const newWhere = field ? where : null;
  const touches = (w) => numChanged && (hfInit.numWhere === w || newWhere === w);
  const keepH = !touches('header') && hText + $('#hfHeaderAlign').value === hfInit.header;
  const keepF = !touches('footer') && fText + $('#hfFooterAlign').value === hfInit.footer;
  const header = keepH ? (doc.parts?.header || '') : buildHF(hText, $('#hfHeaderAlign').value, field && where === 'header' ? field : null);
  const footer = keepF ? (doc.parts?.footer || '') : buildHF(fText, $('#hfFooterAlign').value, field && where === 'footer' ? field : null);
  doc.parts = header || footer ? { header, footer } : null;
  $('#hfDlg').hidden = true;
  autosave(); layout();
  toast(doc.parts ? '머리말·꼬리말을 적용했습니다 (저장하면 모든 쪽에 들어갑니다)' : '머리말·꼬리말을 지웠습니다');
}

function setZoom(z) {
  doc.zoom = Math.min(3, Math.max(0.3, Math.round(z * 100) / 100));
  layout();
}
// 사용자가 확대를 직접 바꾸기 전까지는 화면 폭에 맞춰 자동으로 정한다
// (워드 화면이 숨겨진 동안에는 폭이 0이라 계산하지 않는다)
let userZoomed = false;
function autoZoom() {
  if (userZoomed || !workspace.clientWidth) return;
  const w = workspace.clientWidth - 24;
  setZoom(w < page.offsetWidth ? w / page.offsetWidth : 1);
}
function fitZoom() {
  setZoom((workspace.clientWidth - 24) / page.offsetWidth);
}

/* ---------- 글자 모양 ---------- */
function fixFonts() {
  editor.querySelectorAll('font[size="7"]').forEach((f) => {
    f.removeAttribute('size');
    f.style.fontSize = `${pendingPt}pt`;
    f.querySelectorAll('[style]').forEach((x) => { x.style.fontSize = ''; });
  });
}
function setFontSize(pt) {
  pendingPt = pt;
  restoreSel();
  document.execCommand('styleWithCSS', false, false);
  document.execCommand('fontSize', false, '7');
  document.execCommand('styleWithCSS', false, true);
  changed();
}

function selBlocks() {
  if (!savedRange) return [];
  return $$('p,h1,h2,h3,li,div:not(.page-break),td', editor)
    .filter((b) => savedRange.intersectsNode(b) && !b.querySelector('p,h1,h2,h3,li,div,td'));
}
function setLineHeight(v) {
  restoreSel();
  let list = selBlocks();
  if (!list.length) { document.execCommand('formatBlock', false, 'p'); list = selBlocks(); }
  list.forEach((b) => { b.style.lineHeight = v; });
  changed();
}

function refreshToolbar() {
  $$('[data-cmd]').forEach((b) => {
    let on = false;
    try { on = document.queryCommandState(b.dataset.cmd); } catch { /* 무시 */ }
    b.classList.toggle('active', on && !['removeFormat', 'indent', 'outdent'].includes(b.dataset.cmd));
  });
  let el = savedRange?.startContainer;
  if (!el) return;
  if (el.nodeType === 3) el = el.parentElement;
  if (!el || !editor.contains(el)) return;
  const cs = getComputedStyle(el);
  const px = parseFloat(cs.fontSize);
  const pt = Math.round(px * 0.75 * 2) / 2;
  $('#sizeSel').value = SIZES.includes(pt) ? String(pt) : '';
  const fam = cs.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');
  const fs = $('#fontSel');
  fs.value = [...fs.options].some((o) => o.value === fam) ? fam : '';
  const h = el.closest('h1,h2,h3');
  $('#styleSel').value = h && editor.contains(h) ? h.tagName.toLowerCase() : 'p';
  const lh = parseFloat(cs.lineHeight) / px;
  const ls = $('#lineSel');
  const near = [...ls.options].find((o) => Math.abs(+o.value - lh) < 0.06);
  ls.value = near ? near.value : '';
}

/* ---------- 입력 ---------- */
function setCaret(node, atEnd) {
  const r = document.createRange();
  r.selectNodeContents(node); r.collapse(!atEnd);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  savedRange = r.cloneRange();
}

// 표·가로선·쪽 나누기처럼 한 줄을 통째로 차지하는 것을 지금 문단 아래에 넣는다
function insertBlock(html) {
  restoreSel();
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const nodes = [...tpl.content.childNodes];
  const sel = getSelection();
  let b = sel.anchorNode;
  if (b === editor) b = editor.childNodes[Math.min(sel.anchorOffset, editor.childNodes.length - 1)] || null;
  while (b && b.parentNode !== editor) b = b.parentNode;
  if (!b) editor.append(...nodes);
  else {
    const empty = b.nodeType === 1 && b.tagName === 'P' && !b.textContent && !b.querySelector('img,table,hr');
    b.after(...nodes);
    if (empty) b.remove();
  }
  const firstCell = nodes.find((n) => n.nodeType === 1 && n.tagName === 'TABLE')?.querySelector('td');
  setCaret(firstCell || nodes[nodes.length - 1], false);
  changed();
}

function insertTable(rows, cols) {
  const tr = `<tr>${'<td><br></td>'.repeat(cols)}</tr>`;
  insertBlock(`<table><tbody>${tr.repeat(rows)}</tbody></table>${EMPTY}`);
}

function curCell() {
  let n = savedRange?.startContainer;
  if (!n) return null;
  if (n.nodeType === 3) n = n.parentElement;
  const c = n?.closest?.('td,th');
  return c && editor.contains(c) ? c : null;
}
function tableOp(kind) {
  const c = curCell();
  if (!c) { toast('표 안을 먼저 눌러 주세요'); return; }
  const tr = c.parentElement; const table = c.closest('table'); const ci = c.cellIndex;
  if (kind === 'rowAdd') {
    const n = tr.cloneNode(true);
    [...n.cells].forEach((x) => { x.innerHTML = '<br>'; });
    tr.after(n);
  } else if (kind === 'colAdd') {
    for (const r of table.rows) {
      const td = document.createElement('td'); td.innerHTML = '<br>';
      r.cells[Math.min(ci, r.cells.length - 1)].after(td);
    }
  } else if (kind === 'rowDel') {
    if (table.rows.length === 1) table.remove(); else tr.remove();
    savedRange = null;
  } else if (kind === 'colDel') {
    if (tr.cells.length === 1) table.remove();
    else for (const r of table.rows) r.cells[ci]?.remove();
    savedRange = null;
  } else if (kind === 'tblDel') {
    table.remove(); savedRange = null;
  }
  changed();
}

function insertImage(file) {
  const fr = new FileReader();
  fr.onload = () => {
    const img = new Image();
    img.onload = () => {
      const { m, W } = pageDims();
      const maxW = (W - m.l - m.r) * MM;
      const w = Math.round(Math.min(img.naturalWidth, maxW));
      const h = Math.round(img.naturalHeight * (w / img.naturalWidth));
      restoreSel();
      const el = document.createElement('img');
      el.src = fr.result; el.width = w; el.height = h;
      const r = getSelection().getRangeAt(0);
      r.deleteContents(); r.insertNode(el); r.setStartAfter(el); r.collapse(true);
      savedRange = r.cloneRange();
      changed();
    };
    img.src = fr.result;
  };
  fr.readAsDataURL(file);
}

/* ---------- 찾아 바꾸기 ---------- */
const find = { q: '', node: null, off: 0 };
function textNodes() {
  const w = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  const a = [];
  while (w.nextNode()) a.push(w.currentNode);
  return a;
}
function findNext(silent) {
  const q = $('#findText').value;
  if (!q) { toast('찾을 말을 넣어 주세요'); return false; }
  const nodes = textNodes();
  let start = 0; let off = 0;
  if (find.q === q && find.node) {
    const i = nodes.indexOf(find.node);
    if (i >= 0) { start = i; off = find.off; }
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let i = start; i < nodes.length; i++) {
      const idx = nodes[i].data.indexOf(q, i === start ? off : 0);
      if (idx >= 0) {
        const r = document.createRange();
        r.setStart(nodes[i], idx); r.setEnd(nodes[i], idx + q.length);
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
        savedRange = r.cloneRange();
        nodes[i].parentElement.scrollIntoView({ block: 'center' });
        Object.assign(find, { q, node: nodes[i], off: idx + q.length });
        return true;
      }
    }
    start = 0; off = 0;
  }
  find.node = null;
  if (!silent) toast('찾는 말이 없습니다');
  return false;
}
function replaceOne() {
  const q = $('#findText').value;
  if (savedRange && q && savedRange.toString() === q) {
    const node = savedRange.startContainer; const at = savedRange.startOffset;
    const rep = $('#replText').value;
    node.data = node.data.slice(0, at) + rep + node.data.slice(at + q.length);
    Object.assign(find, { q, node, off: at + rep.length });
    savedRange = null;
    changed();
  }
  findNext();
}
function replaceAll() {
  const q = $('#findText').value;
  if (!q) { toast('찾을 말을 넣어 주세요'); return; }
  const rep = $('#replText').value;
  let n = 0;
  for (const t of textNodes()) {
    const parts = t.data.split(q);
    if (parts.length > 1) { n += parts.length - 1; t.data = parts.join(rep); }
  }
  find.node = null; savedRange = null;
  changed();
  toast(n ? `${n}곳을 바꿨습니다` : '찾는 말이 없습니다');
}

/* ---------- 파일 ---------- */
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function docName() {
  return ($('#docName').value.trim() || '새 문서').replace(/[\\/:*?"<>|]/g, '_');
}

// 짧은 지문(FNV-1a): 저장해 둔 원본이 지금 워드 내용과 같은지 확인할 때 쓴다
function hashText(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${s.length.toString(16)}-${h.toString(16)}`;
}

// 머리글·바닥글을 화면 밖 무대에 그려 워드 저장에 넘긴다
function stageParts(parts, widthPx) {
  const stage = $('#exportStage');
  const make = (html) => {
    if (!html) return null;
    const d = document.createElement('div');
    d.style.width = `${widthPx}px`;
    d.innerHTML = html;
    d.querySelectorAll('td:empty, th:empty').forEach((c) => { c.innerHTML = '<br>'; });
    stage.append(d);
    return d;
  };
  const header = make(parts?.header); const footer = make(parts?.footer);
  return { header, footer, done: () => { header?.remove(); footer?.remove(); } };
}

async function buildDocx() {
  flush();
  const name = docName();
  const [{ exportDocx }, { default: JSZip }] = await Promise.all([import('./docx-export.js'), import('jszip')]);
  const parts = stageParts(doc.parts, editor.clientWidth);
  let blob;
  try {
    blob = await exportDocx(editor, { name, orient: doc.orient, m: MARGINS[doc.margin], header: parts.header, footer: parts.footer, hf: doc.hf });
  } finally { parts.done(); }
  // 이 편집기에서 다시 열 때 모양이 그대로 살아나도록 원본을 함께 넣어 둔다
  const zip = await JSZip.loadAsync(blob);
  const docHash = hashText(await zip.file('word/document.xml').async('string'));
  const payload = b64encode(JSON.stringify({ html: editor.innerHTML, ...pageState(), docHash }));
  zip.file(OWN_PART, `<?xml version="1.0" encoding="UTF-8"?><hangulEditor xmlns="urn:hangul-editor" version="1">${payload}</hangulEditor>`);
  return zip.generateAsync({
    type: 'blob', compression: 'DEFLATE',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

async function saveDocx() {
  toast('문서를 만드는 중…');
  try {
    const name = docName();
    const out = await buildDocx();
    if (desktop) {
      const saved = await desktop.saveFile({ name, ext: 'docx', data: new Uint8Array(await out.arrayBuffer()) });
      toast(saved ? '저장했습니다' : '저장을 취소했습니다');
      return out;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(out);
    a.download = `${name}.docx`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(`${name}.docx 로 저장했습니다`);
    return out;
  } catch (e) {
    console.error(e);
    toast('저장하지 못했습니다');
    return null;
  }
}

/* ---------- 형식 변환 (한글 프로그램 없이) ---------- */
const INLINE_TAGS = new Set(['SPAN', 'FONT', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'SUP', 'SUB', 'A', 'MARK', 'SMALL', 'BIG']);
const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'LI', 'TD', 'TH', 'DIV', 'BLOCKQUOTE']);
const px2pt = (v) => Math.round(parseFloat(v) * 0.75 * 10) / 10;

function cssColor(v) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(v || '');
  if (!m || (m[4] !== undefined && parseFloat(m[4]) === 0)) return null;
  return `#${[m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, '0')).join('')}`;
}

// 화면에 보이는 모양을 그대로 글자마다 적어 넣은 HTML을 만든다 (한글 엔진에 붙여 넣을 때 기본값이 끼어들지 않게)
function explicitHtml(root) {
  const out = document.createElement('div');
  const textCss = (el) => {
    const cs = getComputedStyle(el);
    // 첨자는 한글이 스스로 줄여 그리므로 화면에서 줄인 크기(1/1.2)를 되돌려 적는다
    const script = cs.verticalAlign === 'super' || cs.verticalAlign === 'sub';
    const css = [
      `font-family:'${cs.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '')}'`,
      `font-size:${px2pt(parseFloat(cs.fontSize) * (script ? 1.2 : 1))}pt`,
    ];
    const color = cssColor(cs.color); if (color) css.push(`color:${color}`);
    if (parseInt(cs.fontWeight, 10) >= 600) css.push('font-weight:bold');
    if (cs.fontStyle === 'italic') css.push('font-style:italic');
    let underline = false; let strike = false; let bg = null;
    for (let n = el; n && n !== root && !BLOCK_TAGS.has(n.tagName); n = n.parentElement) {
      const c = getComputedStyle(n);
      const deco = c.textDecorationLine || '';
      if (deco.includes('underline')) underline = true;
      if (deco.includes('line-through')) strike = true;
      if (!bg) bg = cssColor(c.backgroundColor);
    }
    const deco = [underline && 'underline', strike && 'line-through'].filter(Boolean).join(' ');
    if (deco) css.push(`text-decoration:${deco}`);
    if (bg) css.push(`background-color:${bg}`);
    if (cs.verticalAlign === 'super' || cs.verticalAlign === 'sub') css.push(`vertical-align:${cs.verticalAlign}`);
    return css.join(';');
  };
  const blockCss = (el) => {
    const cs = getComputedStyle(el);
    const css = [`text-align:${cs.textAlign === 'start' ? 'left' : cs.textAlign}`];
    const lh = parseFloat(cs.lineHeight); const fs = parseFloat(cs.fontSize);
    // 'normal'(워드의 1줄)은 글자 크기의 약 1.3배이다
    if (fs) css.push(`line-height:${Math.round((Number.isFinite(lh) ? lh / fs : 1.3) * 100)}%`);
    for (const [k, v] of [['margin-left', cs.marginLeft], ['text-indent', cs.textIndent], ['margin-top', cs.marginTop], ['margin-bottom', cs.marginBottom]]) {
      if (parseFloat(v)) css.push(`${k}:${px2pt(v)}pt`);
    }
    const bg = cssColor(cs.backgroundColor);
    if (bg && bg !== '#ffffff') css.push(`background-color:${bg}`);
    if (el.tagName === 'TD' || el.tagName === 'TH') {
      // 표 칸: 한글 엔진은 칸 style의 너비·안쪽 여백·테두리·세로 정렬을 읽는다 (없으면 테두리가 사라지고 가운데 정렬이 된다)
      const z = doc.zoom || 1;
      css.push(`width:${px2pt(el.getBoundingClientRect().width / z)}pt`);
      // 한글은 칸의 첫 문단 위 간격·마지막 문단 아래 간격을 칸 높이에 넣지 않으므로 칸 안쪽 여백으로 옮긴다
      const blocks = [...el.children].filter((c) => BLOCK_TAGS.has(c.tagName) || /^H[1-6]$/.test(c.tagName));
      const extraTop = blocks.length ? parseFloat(getComputedStyle(blocks[0]).marginTop) || 0 : 0;
      const extraBottom = blocks.length ? parseFloat(getComputedStyle(blocks[blocks.length - 1]).marginBottom) || 0 : 0;
      const pad = [parseFloat(cs.paddingTop) + extraTop, parseFloat(cs.paddingRight), parseFloat(cs.paddingBottom) + extraBottom, parseFloat(cs.paddingLeft)];
      css.push(`padding:${pad.map((v) => `${px2pt(v)}pt`).join(' ')}`);
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
        const st = cs[`border${side}Style`]; const w = parseFloat(cs[`border${side}Width`]) || 0;
        css.push(st === 'none' || st === 'hidden' || !w
          ? `border-${side.toLowerCase()}:none`
          : `border-${side.toLowerCase()}:${px2pt(w)}pt ${st} ${cssColor(cs[`border${side}Color`]) || '#000000'}`);
      }
      css.push(`vertical-align:${cs.verticalAlign === 'middle' ? 'middle' : cs.verticalAlign === 'bottom' ? 'bottom' : 'top'}`);
    }
    return css.join(';');
  };
  // 목록은 한글 엔진이 번호를 글머리표로 바꾸므로, 번호·글머리를 글자로 적은 문단으로 바꿔 넣는다
  const rootLeft = root.getBoundingClientRect().left;
  const list = (ul, target) => {
    let no = 0;
    for (const li of ul.children) {
      if (li.tagName !== 'LI') continue;
      no += 1;
      const p = document.createElement('p');
      const indent = (li.getBoundingClientRect().left - rootLeft) / (doc.zoom || 1);
      p.setAttribute('style', `${blockCss(li).replace(/margin-left:[^;]*;?/, '')};margin-left:${px2pt(indent)}pt`);
      const mark = document.createElement('span');
      // 번호·글머리 기호는 항목 첫 글자와 같은 모양으로 (형광펜은 빼고)
      const tw = document.createTreeWalker(li, NodeFilter.SHOW_TEXT, { acceptNode: (t) => (t.data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) });
      const first = tw.nextNode();
      mark.setAttribute('style', textCss(first ? first.parentElement : li).replace(/;?background-color:[^;]*/g, '').replace(/;?text-decoration:[^;]*/g, ''));
      mark.textContent = ul.tagName === 'OL' ? `${no}. ` : '• ';
      p.append(mark);
      const nested = [...li.children].filter((c) => c.tagName === 'UL' || c.tagName === 'OL');
      walk({ childNodes: [...li.childNodes].filter((c) => !nested.includes(c)) }, p);
      target.append(p);
      for (const n of nested) list(n, target);
    }
  };
  const walk = (node, target) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 1 && (n.tagName === 'UL' || n.tagName === 'OL')) { list(n, target); continue; }
      if (n.nodeType === 3) {
        if (!n.data) continue;
        const s = document.createElement('span');
        s.setAttribute('style', textCss(n.parentElement));
        s.textContent = n.data.replace(/ /g, ' ');
        target.append(s);
        continue;
      }
      if (n.nodeType !== 1) continue;
      if (INLINE_TAGS.has(n.tagName)) { walk(n, target); continue; }
      // 제목(h1~h3)은 모양을 이미 글자마다 적었으므로 보통 문단으로 넘긴다 (쪽 나누기 처리도 같게)
      const c = /^H[1-6]$/.test(n.tagName) ? document.createElement('p') : n.cloneNode(false);
      if (BLOCK_TAGS.has(n.tagName) && !n.classList.contains('page-break')) c.setAttribute('style', blockCss(n));
      target.append(c);
      walk(n, c);
    }
  };
  walk(root, out);
  return out.innerHTML;
}

async function saveBytes(bytes, name, ext, mime) {
  if (desktop) return desktop.saveFile({ name, ext, data: bytes });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: mime }));
  a.download = `${name}.${ext}`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return `${name}.${ext}`;
}

// 워드 화면의 문서를 한글(.hwp)로 저장 — 한글 프로그램 없이 rhwp 엔진으로 만든다
async function saveHwp() {
  flush();
  toast('한글 문서로 바꾸는 중…');
  try {
    const { htmlToHwp } = await import('./engine.js');
    const bytes = await htmlToHwp(explicitHtml(editor), { orient: doc.orient, m: MARGINS[doc.margin] }, 'hwp');
    const saved = await saveBytes(bytes, docName(), 'hwp', 'application/x-hwp');
    toast(saved ? '한글(.hwp)로 저장했습니다' : '저장을 취소했습니다');
    return bytes;
  } catch (e) {
    console.error(e);
    toast('한글로 저장하지 못했습니다');
    return null;
  }
}

// 한글 문서(.hwpx 바이트)를 워드(.docx)로 — 한글 화면의 "워드로 저장"에서 쓴다
async function hwpxToDocxBlob(hwpxBytes, name) {
  const [{ default: JSZip }, { hwpxToDoc }, { exportDocx }] = await Promise.all([
    import('jszip'), import('./hwpx-import.js'), import('./docx-export.js'),
  ]);
  const r = await hwpxToDoc(await JSZip.loadAsync(hwpxBytes));
  const orient = r.orient === 'landscape' ? 'landscape' : 'portrait';
  const m = r.m || MARGINS.normal;
  const stage = $('#exportStage');
  const width = ((orient === 'portrait' ? 210 : 297) - m.l - m.r) * MM;
  stage.style.width = `${width}px`;
  const body = document.createElement('div');
  body.innerHTML = sanitize(r.html);
  body.querySelectorAll('td:empty, th:empty').forEach((c) => { c.innerHTML = '<br>'; });
  stage.replaceChildren(body);
  const parts = stageParts(r.parts && { header: sanitize(r.parts.header || ''), footer: sanitize(r.parts.footer || '') }, width);
  try {
    return await exportDocx(body, { name, orient, m, header: parts.header, footer: parts.footer, hf: r.hf });
  } finally {
    stage.replaceChildren();
  }
}

const MODE_KEY = 'hangul-editor-mode';
function setMode(mode) {
  document.body.dataset.mode = mode;
  $('#modeBadge').textContent = mode === 'hwp' ? '한글 문서' : '워드 문서';
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* 무시 */ }
  if (mode === 'docx') { layout(); autoZoom(); }
}

function pickFile() {
  if (desktop) desktop.openDialog().then((f) => { if (f) openFile(new File([f.data], f.name), f.path); });
  else $('#fileDocx').click();
}

function newDocx() {
  cloud.leave();
  setMode('docx');
  if (editor.innerText.trim() && !confirm('지금 워드 문서를 지우고 새 문서를 만들까요?')) return;
  setContent(''); $('#docName').value = '새 문서'; savedRange = null;
  doc.orient = 'portrait'; doc.margin = 'normal'; doc.parts = null; doc.hf = null;
  applyPage(); flush();
}


// 클라우드: 지금 문서를 바이트로, 받은 문서 열기
const cloudCtx = {
  async getDoc() {
    if (document.body.dataset.mode === 'hwp') return hwpCurrentDoc();
    const blob = await buildDocx();
    return { bytes: new Uint8Array(await blob.arrayBuffer()), name: `${docName()}.docx`, format: 'docx' };
  },
  async openBytes(bytes, name) { await openFile(new File([bytes], name)); },
  async markSaved() { if (document.body.dataset.mode === 'hwp') await hwpMarkSavedCloud(); else $('#saveState').textContent = '클라우드 저장됨'; },
  cloud: {
    save: () => cloud.saveToCloud(), share: () => cloud.shareDialog(), versions: () => cloud.versionsDialog(),
    openLink: () => cloud.openFromClipboard(), leave: () => cloud.leave(), account: () => cloud.accountDialog(),
  },
};

async function openFile(file, filePath) {
  await cloud.leave(); // 클라우드 문서를 받는 중이면 그대로 둔다
  toast('문서를 여는 중…');
  try {
    const buf = await file.arrayBuffer();
    const sig = new Uint8Array(buf.slice(0, 4));
    let html = null; let pageSt = null;
    const isCfb = sig[0] === 0xd0 && sig[1] === 0xcf && sig[2] === 0x11 && sig[3] === 0xe0;
    if (isCfb || /\.hwpx?$/i.test(file.name)) {
      // 한글 문서는 rhwp 편집기로 연다
      return await openHwp(new Uint8Array(buf), file.name, filePath);
    }
    if (sig[0] === 0x50 && sig[1] === 0x4b) {
      const { default: JSZip } = await import('jszip');
      const zip = await JSZip.loadAsync(buf);
      const own = zip.file(OWN_PART);
      if (zip.file('Contents/section0.xml')) {
        return await openHwp(new Uint8Array(buf), file.name.replace(/\.[^.]*$/, '') + '.hwpx', filePath);
      }
      if (own) {
        const m = />([A-Za-z0-9+/=]+)<\/hangulEditor>/.exec(await own.async('string'));
        if (m) {
          const data = JSON.parse(b64decode(m[1]));
          // 이 편집기로 저장한 뒤 워드에서 고쳤다면 넣어 둔 원본은 낡았으므로 워드 내용을 읽는다
          const body = await zip.file('word/document.xml')?.async('string');
          if (!data.docHash || data.docHash === hashText(body || '')) { html = data.html; pageSt = data; }
        }
      }
      if (html === null) {
        if (!zip.file('word/document.xml')) throw new Error('지원하지 않는 형식');
        // 워드에서 만든 문서: 직접 해석해서 글자·문단 모양, 표, 그림, 용지 설정을 살린다
        const { docxToDoc } = await import('./docx-import.js');
        const r = await docxToDoc(zip);
        html = r.html; pageSt = r;
      }
    } else throw new Error('지원하지 않는 형식');
    setMode('docx');
    doc.orient = 'portrait'; doc.margin = 'normal';
    applyPageState(pageSt);
    setContent(sanitize(html));
    $('#docName').value = file.name.replace(/\.(docx|hwpx?)$/i, '');
    savedRange = null;
    hist.stack = []; hist.i = -1;
    applyPage(); flush(); autoZoom();
    workspace.scrollTop = 0;
    toast('문서를 열었습니다');
    return true;
  } catch (e) {
    console.error(e);
    toast('열 수 없는 파일입니다 (.hwp · .hwpx · .docx만 가능)');
    return false;
  }
}

/* ---------- 동작 연결 ---------- */
const actions = {
  new() { newDocx(); },
  newHwp() { newHwpDocument(); },
  open() { pickFile(); },
  save() { saveDocx(); },
  saveHwp() { saveHwp(); },
  print() { flush(); window.print(); },
  undo() { step(-1); },
  redo() { step(1); },
  copy() { restoreSel(); document.execCommand('copy'); },
  cut() { restoreSel(); document.execCommand('cut'); changed(); },
  async paste() {
    // 단추로 붙일 때: 서식 있는 내용이 있으면 그대로, 없으면 글만
    restoreSel();
    try {
      for (const item of await navigator.clipboard.read()) {
        if (item.types.includes('text/html')) {
          const html = await (await item.getType('text/html')).text();
          document.execCommand('insertHTML', false, sanitize(html));
          changed();
          return;
        }
        if (item.types.includes('text/plain')) {
          document.execCommand('insertText', false, await (await item.getType('text/plain')).text());
          changed();
          return;
        }
      }
      toast('붙일 내용이 없습니다');
    } catch {
      try {
        const t = await navigator.clipboard.readText();
        if (t) { restoreSel(); document.execCommand('insertText', false, t); changed(); }
      } catch { toast('붙이지 못했습니다. 문서 안을 누른 뒤 다시 시도하세요'); }
    }
  },
  fontCredits() { openFontCredits(); },
  cloudSave() { cloud.saveToCloud(); },
  cloudShare() { cloud.shareDialog(); },
  cloudVersions() { cloud.versionsDialog(); },
  cloudOpen() { cloud.openFromClipboard(); },
  cloudAccount() { cloud.accountDialog(); },
  hf() { openHF(false); },
  hfNum() { openHF(true); },
  hfClose() { $('#hfDlg').hidden = true; },
  hfApply() { applyHF(); },
  hfRemove() { doc.parts = null; $('#hfDlg').hidden = true; autosave(); layout(); toast('머리말·꼬리말을 지웠습니다'); },
  find() { $('#findDlg').hidden = false; },
  findClose() { $('#findDlg').hidden = true; },
  findNext() { findNext(); },
  replOne() { replaceOne(); },
  replAll() { replaceAll(); },
  image() { $('#fileImg').click(); },
  date() {
    restoreSel();
    document.execCommand('insertText', false, new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' }));
    changed();
  },
  hr() { insertBlock(`<hr>${EMPTY}`); },
  pagebreak() { insertBlock(`<div class="page-break" contenteditable="false"></div>${EMPTY}`); },
  rowAdd() { tableOp('rowAdd'); }, colAdd() { tableOp('colAdd'); },
  rowDel() { tableOp('rowDel'); }, colDel() { tableOp('colDel'); }, tblDel() { tableOp('tblDel'); },
  zoomIn() { userZoomed = true; setZoom(doc.zoom + 0.1); },
  zoomOut() { userZoomed = true; setZoom(doc.zoom - 0.1); },
  zoom100() { userZoomed = true; setZoom(1); },
  zoomFit() { userZoomed = true; fitZoom(); },
  guides() {
    doc.guides = !doc.guides;
    guides.classList.toggle('off', !doc.guides);
    $('#guideBtn').classList.toggle('active', doc.guides);
  },
};

function closePops(except) {
  $$('.pop').forEach((p) => { if (p !== except) p.hidden = true; });
}

function init() {
  document.body.dataset.mode = 'docx'; // 시작 모드는 아래 startMode에서 정한다
  // 고르기 상자 채우기
  $('#sizeSel').innerHTML = SIZES.map((s) => `<option value="${s}">${s}pt</option>`).join('');
  $('#sizeSel').value = '10'; // 새 문서 기본 글자 크기
  // 함께 넣은 공공누리 글꼴을 글꼴 목록에 붙인다 (없으면 그냥 넘어간다)
  loadFontPack().then((pack) => {
    if (pack) {
      injectFontCss(document, pack);
      addKoglGroup($('#fontSel'), pack);
    }
  });
  $('#popColor').innerHTML = `<div class="swatches">${COLORS.map((c) => `<button data-color="${c}" style="background:${c}" title="${c}"></button>`).join('')}</div>`;
  $('#popHilite').innerHTML = `<div class="swatches">${HILITES.map((c) => `<button data-hilite="${c}" style="background:${c === 'transparent' ? '#fff' : c}">${c === 'transparent' ? '없음' : ''}</button>`).join('')}</div>`;
  $('#popChars').innerHTML = [...CHARS].map((c) => `<button data-char="${c}">${c}</button>`).join('');
  const grid = $('#tblGrid');
  for (let r = 1; r <= 6; r++) for (let c = 1; c <= 8; c++) grid.insertAdjacentHTML('beforeend', `<div data-r="${r}" data-c="${c}"></div>`);
  const paint = (R, C) => {
    $$('div', grid).forEach((d) => d.classList.toggle('on', +d.dataset.r <= R && +d.dataset.c <= C));
    $('#tblLabel').textContent = R ? `${R}줄 × ${C}칸` : '줄 × 칸을 고르세요';
  };
  grid.addEventListener('pointerover', (e) => { const d = e.target.closest('[data-r]'); if (d) paint(+d.dataset.r, +d.dataset.c); });
  grid.addEventListener('click', (e) => {
    const d = e.target.closest('[data-r]');
    if (d) { insertTable(+d.dataset.r, +d.dataset.c); closePops(); paint(0, 0); }
  });

  // 아이콘 단추 채우기, 확대 슬라이더, 머리말·꼬리말 미리 보기 누르기
  $$('[data-ico]').forEach((el) => { el.innerHTML = icon(el.dataset.ico); });
  $('#zoomSlider').addEventListener('input', (e) => { userZoomed = true; setZoom(+e.target.value / 100); });
  $('#hdrView').addEventListener('click', () => openHF(false));
  $('#ftrView').addEventListener('click', () => openHF(false));

  // 단추를 눌러도 글의 선택 영역이 풀리지 않게 한다
  document.addEventListener('mousedown', (e) => {
    if (e.target.closest('button') && !e.target.closest('#editor')) e.preventDefault();
  });

  document.addEventListener('click', (e) => {
    const t = e.target;
    const tab = t.closest('[data-tab]');
    if (tab) {
      $$('[data-tab]').forEach((b) => b.classList.toggle('on', b === tab));
      $$('.panel').forEach((p) => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
      closePops(); layout();
      return;
    }
    const popBtn = t.closest('[data-pop]');
    if (popBtn) {
      const pop = $(`#${popBtn.dataset.pop}`);
      closePops(pop);
      pop.hidden = !pop.hidden;
      if (!pop.hidden) {
        const r = popBtn.getBoundingClientRect();
        pop.style.top = `${r.bottom + 4}px`;
        pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
      }
      return;
    }
    const b = t.closest('button');
    if (b) {
      if (b.dataset.color) { exec('foreColor', b.dataset.color); $('.colorA').style.borderBottomColor = b.dataset.color; closePops(); return; }
      if (b.dataset.hilite) { exec('hiliteColor', b.dataset.hilite); closePops(); return; }
      if (b.dataset.char) { restoreSel(); document.execCommand('insertText', false, b.dataset.char); changed(); return; }
      if (b.dataset.cmd) { exec(b.dataset.cmd); return; }
      if (b.dataset.orient) { doc.orient = b.dataset.orient; applyPage(); autosave(); return; }
      if (b.dataset.margin) { doc.margin = b.dataset.margin; applyPage(); autosave(); return; }
      if (b.dataset.act && actions[b.dataset.act]) { actions[b.dataset.act](); return; }
    }
    if (!t.closest('.pop')) closePops();
  });

  $('#styleSel').addEventListener('change', (e) => exec('formatBlock', e.target.value));
  $('#fontSel').addEventListener('change', (e) => exec('fontName', e.target.value));
  $('#sizeSel').addEventListener('change', (e) => setFontSize(+e.target.value));
  $('#lineSel').addEventListener('change', (e) => setLineHeight(e.target.value));
  $('#docName').addEventListener('input', autosave);
  $('#findText').addEventListener('input', () => { find.node = null; });

  $('#fileDocx').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) openFile(f); });

  // 문서 파일을 창에 끌어다 놓아도 열린다
  addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f && /\.(docx|hwpx?)$/i.test(f.name)) { e.preventDefault(); openFile(f); }
  });

  initHwp({
    toast, desktop, setMode, pickFile, newDocx,
    getName: docName,
    setBadge: (t) => { $('#modeBadge').textContent = t; },
    hwpxToDocxBlob,
    saveBytes,
    setName: (n) => { $('#docName').value = n; },
    setSaveState: (t) => { $('#saveState').textContent = t; },
    fontCredits: openFontCredits,
    cloud: cloudCtx.cloud,
  });
  cloud.initCloud({ ...cloudCtx, toast, desktop });

  // 설치형(.exe) 전용 기능
  let startedWithFile = false;
  if (desktop) {
    const openFromDesktop = (f) => { if (f) { startedWithFile = true; openFile(new File([f.data], f.name), f.path); } };
    desktop.onOpenFile(openFromDesktop);
    desktop.initialFile().then((f) => { openFromDesktop(f); if (!f) startMode(); });
  }

  // 처음 화면: 지난번에 쓰던 종류로, 없으면 한글 문서로 시작
  function startMode() {
    if (startedWithFile) return;
    let last = 'hwp';
    try { last = localStorage.getItem(MODE_KEY) || 'hwp'; } catch { /* 무시 */ }
    if (last === 'docx') setMode('docx'); else showHwp();
    // 저장하지 못하고 닫힌 한글 문서가 있으면 되살릴지 묻는다
    offerRecovery().catch((e) => console.error(e));
  }
  if (!desktop) startMode();
  $('#fileImg').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) insertImage(f); });

  editor.addEventListener('input', changed);
  editor.addEventListener('beforeinput', (e) => {
    if (e.inputType === 'historyUndo') { e.preventDefault(); step(-1); }
    if (e.inputType === 'historyRedo') { e.preventDefault(); step(1); }
  });
  editor.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'z') { e.preventDefault(); step(e.shiftKey ? 1 : -1); }
    else if (k === 'y') { e.preventDefault(); step(1); }
    else if (k === 's') { e.preventDefault(); saveDocx(); }
  });

  document.execCommand('defaultParagraphSeparator', false, 'p');
  document.execCommand('styleWithCSS', false, true);

  // 이전에 쓰던 문서 되살리기
  let savedTime = 0;
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (saved) {
      savedTime = saved.time || 0;
      setContent(sanitize(saved.html || ''));
      if (saved.name) $('#docName').value = saved.name;
      applyPageState(saved);
    } else setContent('');
  } catch { setContent(''); }
  // 용량이 커서 보관소(IndexedDB)에 넣어 둔 더 새로운 내용이 있으면 그것을 쓴다
  getRecovery('docx').then((r) => {
    if (!r?.html || (r.time || 0) <= savedTime || document.body.dataset.mode !== 'docx') return;
    setContent(sanitize(r.html));
    if (r.name) $('#docName').value = r.name;
    applyPageState(r);
    applyPage(); autoZoom(); record();
  });

  $('#guideBtn').classList.add('active');
  applyPage();
  autoZoom();
  record();
  new ResizeObserver(layout).observe(editor);
  addEventListener('resize', layout);
  refreshToolbar();
}

init();

// 동작 확인용 (화면에는 영향 없음)
window.__editor = { saveDocx, saveHwp, openFile, hwpxToDocxBlob, explicitHtml: () => explicitHtml(editor) };
