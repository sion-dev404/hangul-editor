import './style.css';

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
  return { orient: doc.orient, margin: doc.margin, m: MARGINS[doc.margin] };
}
function applyPageState(s) {
  if (!s) return;
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

const doc = { orient: 'portrait', margin: 'normal', zoom: 1, guides: true };
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
  try {
    localStorage.setItem(STORE, JSON.stringify({ html: editor.innerHTML, name: $('#docName').value, ...pageState() }));
    $('#saveState').textContent = '자동 저장됨';
  } catch {
    $('#saveState').textContent = '자동 저장 불가 (용량 초과)';
  }
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
}

function setZoom(z) {
  doc.zoom = Math.min(3, Math.max(0.3, Math.round(z * 100) / 100));
  layout();
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

async function buildDocx() {
  flush();
  const name = docName();
  const [{ exportDocx }, { default: JSZip }] = await Promise.all([import('./docx-export.js'), import('jszip')]);
  const blob = await exportDocx(editor, { name, orient: doc.orient, m: MARGINS[doc.margin] });
  // 이 편집기에서 다시 열 때 모양이 그대로 살아나도록 원본을 함께 넣어 둔다
  const zip = await JSZip.loadAsync(blob);
  const payload = b64encode(JSON.stringify({ html: editor.innerHTML, ...pageState() }));
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

// 한글(.hwp)로 저장 — 설치형에서, 이 PC에 한컴오피스 한글이 있을 때만
async function saveHwp() {
  if (!desktop) return;
  toast('한글 문서로 바꾸는 중… (조금 걸립니다)');
  try {
    const out = await buildDocx();
    const res = await desktop.saveHwp({ name: docName(), data: new Uint8Array(await out.arrayBuffer()) });
    if (res.canceled) toast('저장을 취소했습니다');
    else toast(res.ok ? '한글(.hwp)로 저장했습니다' : `한글로 저장하지 못했습니다: ${res.error || ''}`);
  } catch (e) {
    console.error(e);
    toast('한글로 저장하지 못했습니다');
  }
}

async function openFile(file) {
  toast('문서를 여는 중…');
  try {
    const buf = await file.arrayBuffer();
    const sig = new Uint8Array(buf.slice(0, 4));
    let html = null; let pageSt = null;
    if (sig[0] === 0xd0 && sig[1] === 0xcf && sig[2] === 0x11 && sig[3] === 0xe0) {
      // 한글 5.0 (.hwp)
      const { hwpToDoc } = await import('./hwp-import.js');
      const r = await hwpToDoc(buf);
      html = r.html; pageSt = r;
    } else if (sig[0] === 0x50 && sig[1] === 0x4b) {
      const { default: JSZip } = await import('jszip');
      const zip = await JSZip.loadAsync(buf);
      const own = zip.file(OWN_PART);
      if (zip.file('Contents/section0.xml')) {
        // 한글 (.hwpx)
        const { hwpxToDoc } = await import('./hwp-import.js');
        const r = await hwpxToDoc(zip);
        html = r.html; pageSt = r;
      } else if (own) {
        const m = />([A-Za-z0-9+/=]+)<\/hangulEditor>/.exec(await own.async('string'));
        if (m) { const data = JSON.parse(b64decode(m[1])); html = data.html; pageSt = data; }
      }
      if (html === null) {
        if (!zip.file('word/document.xml')) throw new Error('지원하지 않는 형식');
        const mod = await import('mammoth/mammoth.browser.js');
        const mammoth = mod.default || mod;
        html = (await mammoth.convertToHtml({ arrayBuffer: buf })).value;
      }
    } else throw new Error('지원하지 않는 형식');
    doc.orient = 'portrait'; doc.margin = 'normal';
    applyPageState(pageSt);
    setContent(sanitize(html));
    $('#docName').value = file.name.replace(/\.(docx|hwpx?)$/i, '');
    savedRange = null;
    hist.stack = []; hist.i = -1;
    applyPage(); flush();
    workspace.scrollTop = 0;
    toast('문서를 열었습니다');
    return true;
  } catch (e) {
    console.error(e);
    toast('열 수 없는 파일입니다 (.hwp · .hwpx · .docx만 가능, 암호 걸린 문서는 불가)');
    return false;
  }
}

/* ---------- 동작 연결 ---------- */
const actions = {
  new() {
    if (editor.innerText.trim() && !confirm('지금 문서를 지우고 새 문서를 만들까요?')) return;
    setContent(''); $('#docName').value = '새 문서'; savedRange = null;
    doc.orient = 'portrait'; doc.margin = 'normal';
    applyPage(); flush();
  },
  open() { $('#fileDocx').click(); },
  save() { saveDocx(); },
  saveHwp() { saveHwp(); },
  print() { flush(); window.print(); },
  undo() { step(-1); },
  redo() { step(1); },
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
  zoomIn() { setZoom(doc.zoom + 0.1); },
  zoomOut() { setZoom(doc.zoom - 0.1); },
  zoom100() { setZoom(1); },
  zoomFit() { fitZoom(); },
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
  // 고르기 상자 채우기
  $('#sizeSel').innerHTML = SIZES.map((s) => `<option value="${s}">${s}pt</option>`).join('');
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

  // 설치형(.exe) 전용 기능
  if (desktop) {
    const openFromDesktop = (f) => { if (f) openFile(new File([f.data], f.name)); };
    desktop.onOpenFile(openFromDesktop);
    desktop.initialFile().then(openFromDesktop);
    desktop.hasHancom().then((yes) => { $('#saveHwpBtn').hidden = !yes; });
  }
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
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (saved) {
      setContent(sanitize(saved.html || ''));
      if (saved.name) $('#docName').value = saved.name;
      applyPageState(saved);
    } else setContent('');
  } catch { setContent(''); }

  $('#guideBtn').classList.add('active');
  applyPage();
  if (workspace.clientWidth - 24 < page.offsetWidth) fitZoom();
  record();
  new ResizeObserver(layout).observe(editor);
  addEventListener('resize', layout);
  refreshToolbar();
}

init();

// 동작 확인용 (화면에는 영향 없음)
window.__editor = { saveDocx, openFile };
