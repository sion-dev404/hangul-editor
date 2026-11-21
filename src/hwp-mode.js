// 한글 문서(.hwp/.hwpx) 모드: rhwp 편집기를 안에 띄우고, 워드식 리본으로 조종한다
import { createStudio } from '@rhwp/editor';
import { icon } from './icons.js';
import { putRecovery, getRecovery, delRecovery, clock } from './recovery.js';
import { loadFontPack } from './fonts.js';
import { addKoglGroup, attachFontPicker } from './fontpicker.js';
// 공공누리 글꼴의 한글 화면 연결: 그리기는 studio/kogl-hook.js + tools/patch-studio.mjs가 맡고,
// 여기서는 서식 줄 글꼴 상자(#font-name)에 공공누리 묶음과 표시가 붙는 목록을 단다.

const $ = (s, r = document) => r.querySelector(s);
const host = $('#studioHost');
const tabsEl = $('#hwpTabs');
const ribbonEl = $('#hwpRibbon');

let studio = null;
let creating = null;
let ctx = null; // { toast, desktop, setMode, getName, setName }
const cur = { name: '새 문서', dir: null, format: 'hwp' };

// c: rhwp 명령, a: 이 프로그램의 동작, i: 큰 단추 그림, sq: 네모 단추, t: 풍선 도움말
const RIBBON = [
  { id: 'file', label: '파일', groups: [
    { label: '문서', big: [
      { a: 'newHwp', i: 'doc', l: '새 한글 문서' },
      { a: 'newDocx', i: 'docw', l: '새 워드 문서' },
      { a: 'open', i: 'open', l: '불러오기', s: '.hwp .hwpx .docx' },
    ] },
    { label: '저장', big: [
      { a: 'saveHwp', i: 'save', l: '한글로 저장', s: '.hwp' },
      { a: 'saveHwpx', i: 'save', l: '한글로 저장', s: '.hwpx' },
      { a: 'saveDocx', i: 'save', l: '워드로 저장', s: '.docx' },
      { c: 'file:print-to-pdf', i: 'pdf', l: 'PDF로 저장' },
      { c: 'file:print', i: 'print', l: '인쇄' },
    ] },
    { label: '원본 확인', big: [{ a: 'openInHangul', i: 'openhwp', l: '한글에서 열어 보기', desktopOnly: true }] },
    { label: '정보', big: [{ a: 'fontCredits', i: 'style', l: '글꼴 출처' }] },
  ] },
  { id: 'home', label: '편집', groups: [
    { label: '클립보드', big: [{ c: 'edit:paste', i: 'paste', l: '붙이기' }], rows: [
      [{ c: 'edit:cut', l: '오려 두기' }, { c: 'edit:copy', l: '복사' }],
      [{ c: 'edit:format-copy', l: '모양 복사' }, { c: 'edit:format-paste', l: '모양 붙이기' }],
    ] },
    // 굵게·기울임·밑줄·정렬은 아래 서식 줄에 이미 있으므로 리본에서는 뺐다 (겹치는 단추 제거)
    { label: '글자 모양', rows: [
      [{ c: 'format:superscript', sq: '가<sup>2</sup>', t: '위 첨자' }, { c: 'format:subscript', sq: '가<sub>2</sub>', t: '아래 첨자' },
        { c: 'format:font-size-increase', l: '가 크게' }, { c: 'format:font-size-decrease', l: '가 작게' }],
      [{ c: 'format:char-shape', l: '글자 모양…' }],
    ] },
    { label: '문단 모양', rows: [
      [{ c: 'format:toggle-bullet', l: '● 글머리표' }, { c: 'format:toggle-numbering', l: '1. 번호' },
        { c: 'format:level-decrease', l: '⇤ 내어쓰기' }, { c: 'format:level-increase', l: '⇥ 들여쓰기' }],
      [{ c: 'format:line-spacing-decrease', l: '줄 간격 좁게' }, { c: 'format:line-spacing-increase', l: '줄 간격 넓게' }, { c: 'format:para-shape', l: '문단 모양…' }],
    ] },
    { label: '스타일', big: [{ c: 'format:style-dialog', i: 'style', l: '스타일' }] },
    { label: '편집', big: [{ c: 'edit:find', i: 'find', l: '찾기' }, { c: 'edit:find-replace', i: 'replace', l: '찾아 바꾸기' }], rows: [
      [{ c: 'edit:select-all', l: '모두 선택' }],
    ] },
  ] },
  { id: 'insert', label: '입력', groups: [
    { label: '넣기', big: [
      { c: 'table:create', i: 'table', l: '표' }, { c: 'insert:image', i: 'image', l: '그림' }, { c: 'insert:shape', i: 'shape', l: '도형' },
      { c: 'insert:textbox', i: 'textbox', l: '글상자' }, { c: 'insert:symbols', i: 'symbol', l: '문자표' }, { c: 'insert:equation', i: 'equation', l: '수식' },
    ] },
    { label: '참조', rows: [
      [{ c: 'insert:hyperlink', l: '하이퍼링크' }, { c: 'insert:bookmark', l: '책갈피' }],
      [{ c: 'insert:footnote', l: '각주' }],
    ] },
    { label: '개체', rows: [
      [{ c: 'insert:arrange-front', l: '맨 앞으로' }, { c: 'insert:arrange-back', l: '맨 뒤로' }],
      [{ c: 'format:object-properties', l: '개체 속성…' }, { c: 'insert:picture-delete', l: '개체 지우기' }],
    ] },
  ] },
  { id: 'table', label: '표', groups: [
    { label: '줄 · 칸 추가', rows: [
      [{ c: 'table:insert-row-above', l: '위에 줄' }, { c: 'table:insert-row-below', l: '아래에 줄' }],
      [{ c: 'table:insert-col-left', l: '왼쪽에 칸' }, { c: 'table:insert-col-right', l: '오른쪽에 칸' }],
    ] },
    { label: '지우기', rows: [
      [{ c: 'table:delete-row', l: '줄 지우기' }, { c: 'table:delete-col', l: '칸 지우기' }],
      [{ c: 'table:delete', l: '표 지우기' }],
    ] },
    { label: '셀', rows: [
      [{ c: 'table:cell-merge', l: '셀 합치기' }, { c: 'table:cell-split', l: '셀 나누기' }],
      [{ c: 'table:cell-height-equal', l: '높이 같게' }, { c: 'table:cell-width-equal', l: '너비 같게' }],
    ] },
    { label: '모양', big: [{ c: 'table:cell-props', i: 'gear', l: '표/셀 속성' }, { c: 'table:border-each', i: 'border', l: '테두리' }] },
  ] },
  { id: 'page', label: '쪽', groups: [
    { label: '쪽 설정', big: [{ c: 'page:setup', i: 'pagesetup', l: '편집 용지' }, { c: 'page:break', i: 'pagebreak', l: '쪽 나누기' }] },
    { label: '단', rows: [
      [{ c: 'page:col-1', l: '하나' }, { c: 'page:col-2', l: '둘' }, { c: 'page:col-3', l: '셋' }],
    ] },
    { label: '머리말 · 꼬리말', rows: [
      [{ c: 'page:header-create', l: '머리말' }, { c: 'page:footer-create', l: '꼬리말' }, { c: 'page:headerfooter-close', l: '닫기' }],
      [{ c: 'page:insert-field-pagenum', l: '쪽 번호 넣기' }],
    ] },
  ] },
  { id: 'view', label: '보기', groups: [
    { label: '화면 확대', big: [
      { c: 'view:zoom-out', i: 'zoomout', l: '축소' }, { c: 'view:zoom-in', i: 'zoomin', l: '확대' },
      { c: 'view:zoom-100', i: 'zoom100', l: '100%' }, { c: 'view:zoom-fit-width', i: 'zoomfit', l: '폭 맞춤' }, { c: 'view:zoom-fit-page', i: 'zoomfitpage', l: '쪽 맞춤' },
    ] },
    { label: '표시', rows: [
      [{ c: 'view:para-mark', l: '문단 부호' }],
    ] },
  ] },
];

function btnHtml(b, big) {
  const attr = b.c ? `data-hcmd="${b.c}"` : `data-hact="${b.a}"`;
  const extra = b.desktopOnly ? ' data-desktop-only hidden' : '';
  if (big) return `<button class="big" ${attr}${extra}><i>${icon(b.i)}</i>${b.l}${b.s ? `<small>${b.s}</small>` : ''}</button>`;
  if (b.sq) return `<button class="sq" ${attr} title="${b.t}">${b.sq}</button>`;
  return `<button ${attr}>${b.l}</button>`;
}

function buildRibbon() {
  tabsEl.innerHTML = RIBBON.map((t) => `<button data-htab="${t.id}"${t.id === 'home' ? ' class="on"' : ''}>${t.label}</button>`).join('');
  ribbonEl.innerHTML = RIBBON.map((t) => `<div class="panel" data-hpanel="${t.id}"${t.id === 'home' ? '' : ' hidden'}>${
    t.groups.map((g) => `<div class="group"><div class="gbody">${
      g.big ? `<div class="row">${g.big.map((b) => btnHtml(b, true)).join('')}</div>` : ''}${
      g.rows ? `<div class="rows">${g.rows.map((r) => `<div class="row">${r.map((b) => btnHtml(b, false)).join('')}</div>`).join('')}</div>` : ''
    }</div><div class="glabel">${g.label}</div></div>`).join('')}</div>`).join('');
}

function focusDoc() {
  try { studio?.element.contentWindow?.focus(); } catch { /* 무시 */ }
}

async function ensureStudio() {
  if (studio) return studio;
  if (!creating) {
    creating = (async () => {
      const s = await createStudio(host, {
        studioUrl: new URL('./studio/index.html', location.href).href,
        chrome: { menu: true, toolbar: true, statusbar: true },
        requestTimeoutMs: 15 * 60 * 1000, // 대화 상자를 열어 둔 동안 기다릴 수 있게 넉넉히
      });
      // rhwp 자체 메뉴와 아이콘 줄은 가리고(리본이 대신함), 글꼴·크기·색을 고르는 서식 줄만 남긴다
      try {
        const d = s.element.contentDocument;
        const st = d.createElement('style');
        st.textContent = '#menu-bar, #icon-toolbar { display: none !important; }';
        d.head.append(st);
        const sel = d.getElementById('font-name');
        if (sel) {
          loadFontPack().then((pack) => {
            if (pack) {
              addKoglGroup(sel, pack);
              // rhwp가 문서를 열 때 상자를 다시 채우면 묶음을 다시 붙인다
              new MutationObserver(() => addKoglGroup(sel, pack)).observe(sel, { childList: true });
            }
            attachFontPicker(sel, pack, { more: { label: 'PC 글꼴 · 분류별 보기…' } });
          });
        }
      } catch { await s.chrome.set({ menu: false }).catch(() => {}); }
      await s.commands.execute('view:theme-light').catch(() => {});
      studio = s;
      window.__studio = s; // 동작 확인용
      refreshEnabled();
      return s;
    })().catch((e) => { creating = null; throw e; });
  }
  return creating;
}

let enabledTimer = null;
async function refreshEnabled() {
  if (!studio || document.body.dataset.mode !== 'hwp' || document.hidden) return;
  try {
    const list = await studio.commands.list();
    const map = new Map(list.map((c) => [c.id, c.enabled]));
    document.querySelectorAll('#hwpRibbon [data-hcmd], #quick [data-hcmd]').forEach((b) => { b.disabled = map.get(b.dataset.hcmd) === false; });
  } catch { /* 무시 */ }
}

async function runCommand(id) {
  try {
    const s = await ensureStudio();
    const r = await s.commands.execute(id, undefined, { allowDialog: true });
    if (r && r.ok === false && r.reason !== 'disabled') ctx.toast(r.message || '지금은 쓸 수 없는 기능입니다');
    if (r && r.ok === false && r.reason === 'disabled') ctx.toast('지금 위치에서는 쓸 수 없는 기능입니다');
  } catch (e) {
    console.error(e);
    ctx.toast('실행하지 못했습니다');
  }
  focusDoc();
  refreshEnabled();
}

function download(bytes, fileName, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: mime }));
  a.download = fileName;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function isDirty() {
  try { return !!(await studio.getDocumentState()).dirty; } catch { return false; }
}

/* ---------- 자동 복구 ---------- */
const REC = 'hwp';
let recoverBusy = false;
// 고친 내용이 있으면 몇 초마다 문서를 보관소에 넣어 둔다. 저장하면 지운다.
async function autoRecover() {
  if (recoverBusy || !studio || document.body.dataset.mode !== 'hwp') return;
  recoverBusy = true;
  try {
    if (!(await isDirty())) return;
    const bytes = await studio.exportHwp();
    const ok = await putRecovery(REC, { name: ctx.getName(), bytes, time: Date.now(), format: cur.format, dir: cur.dir });
    ctx.setSaveState?.(ok ? `자동 복구 저장 ${clock()}` : '자동 복구 저장 불가');
  } catch { /* 다음 차례에 다시 */ } finally { recoverBusy = false; }
}

// 지난번에 저장하지 못하고 닫힌 문서가 있으면 되살릴지 묻는다
export async function offerRecovery() {
  const rec = await getRecovery(REC);
  if (!rec?.bytes) return false;
  const when = new Date(rec.time).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  if (!confirm(`저장하지 못하고 닫힌 문서가 있습니다.\n\n문서: ${rec.name}\n마지막 자동 보관: ${when}\n\n되살릴까요? (아니오를 누르면 이 보관본은 지웁니다)`)) {
    await delRecovery(REC);
    return false;
  }
  const ok = await openHwp(new Uint8Array(rec.bytes), `${rec.name}.${rec.format === 'hwpx' ? 'hwpx' : 'hwp'}`, rec.dir ? `${rec.dir}\\${rec.name}` : null, undefined, true);
  if (ok) {
    cur.dir = rec.dir || null;
    ctx.toast('자동 보관된 문서를 되살렸습니다. 꼭 저장해 주세요');
    ctx.setSaveState?.('복구됨 · 저장 필요');
  }
  return ok;
}

async function save(fmt) {
  const s = await ensureStudio();
  const name = ctx.getName();
  ctx.toast('저장하는 중…');
  try {
    if (fmt === 'hwp') {
      const v = await s.exportHwpVerify().catch(() => null);
      if (v && (!v.recovered || v.pageCountBefore !== v.pageCountAfter)
        && !confirm('저장한 파일을 다시 읽어 보는 점검에서 차이가 발견됐습니다.\n원본을 덮어쓰지 말고 다른 이름으로 저장하는 것을 권합니다. 계속할까요?')) return;
    }
    const bytes = fmt === 'hwpx' ? await s.exportHwpx() : await s.exportHwp();
    if (ctx.desktop) {
      const p = await ctx.desktop.saveFile({ name, ext: fmt, data: bytes, dir: cur.dir });
      if (!p) { ctx.toast('저장을 취소했습니다'); return; }
      cur.dir = p.replace(/[\\/][^\\/]*$/, '');
      ctx.setName(p.replace(/^.*[\\/]/, '').replace(/\.(hwpx?)$/i, ''));
    } else {
      download(bytes, `${name}.${fmt}`, fmt === 'hwpx' ? 'application/vnd.hancom.hwpx' : 'application/x-hwp');
    }
    await s.notifySaved(`${ctx.getName()}.${fmt}`).catch(() => {});
    await delRecovery(REC);
    ctx.setSaveState?.(`저장됨 ${clock()}`);
    ctx.toast(`한글 문서(.${fmt})로 저장했습니다`);
  } catch (e) {
    console.error(e);
    ctx.toast('저장하지 못했습니다');
  }
}

// 한글 문서를 워드(.docx)로 저장 — 한글 프로그램 없이 직접 변환한다
async function saveDocx() {
  const s = await ensureStudio();
  ctx.toast('워드 문서로 바꾸는 중…');
  try {
    const name = ctx.getName();
    const blob = await ctx.hwpxToDocxBlob(await s.exportHwpx(), name);
    const saved = await ctx.saveBytes(new Uint8Array(await blob.arrayBuffer()), name, 'docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    ctx.toast(saved ? '워드(.docx)로 저장했습니다' : '저장을 취소했습니다');
  } catch (e) {
    console.error(e);
    ctx.toast('워드로 저장하지 못했습니다');
  }
}

async function openInHangul() {
  if (!ctx.desktop) return;
  try {
    const s = await ensureStudio();
    const r = await ctx.desktop.openInHangul({ name: ctx.getName(), data: await s.exportHwp() });
    if (!r.ok) ctx.toast(r.error || '한글 프로그램을 찾지 못했습니다');
  } catch (e) { console.error(e); ctx.toast('열지 못했습니다'); }
}

const ACTS = {
  // 제목 줄의 "저장": 지금 열린 형식 그대로 저장한다
  saveCurrent: () => save(cur.format === 'hwpx' ? 'hwpx' : 'hwp'),
  open: () => ctx.pickFile(),
  newDocx: () => ctx.newDocx(),
  newHwp: () => newDocument(),
  saveHwp: () => save('hwp'),
  saveHwpx: () => save('hwpx'),
  saveDocx,
  openInHangul,
  fontCredits: () => ctx.fontCredits?.(),
};

export async function newDocument() {
  ctx.setMode('hwp');
  try {
    const s = await ensureStudio();
    await s.commands.execute('file:new-doc', undefined, { allowDialog: true });
    cur.dir = null; cur.format = 'hwp'; cur.origin = 'hwp';
    ctx.setName('새 문서');
    ctx.setSaveState?.('자동 복구 켜짐');
    ctx.setBadge('한글 문서');
  } catch (e) { console.error(e); ctx.toast('한글 편집기를 불러오지 못했습니다'); }
  focusDoc();
}

// origin: 'docx'이면 워드 문서를 한글 형식으로 변환해서 여는 경우
export async function openHwp(bytes, fileName, filePath, origin, keepRecovery) {
  ctx.setMode('hwp');
  if (!origin) ctx.toast('한글 문서를 여는 중…');
  const s = await ensureStudio();
  if (await isDirty() && !confirm('지금 문서에 저장하지 않은 내용이 있습니다. 버리고 다른 문서를 열까요?')) return false;
  // 다른 문서를 열면 이전 문서의 자동 보관본은 필요 없다 (되살린 문서일 때만 남긴다)
  if (!keepRecovery) await delRecovery(REC);
  const base = fileName.replace(/\.(hwpx?|docx)$/i, '');
  const res = await s.loadFile(bytes, origin === 'docx' ? `${base}.hwp` : fileName, { skipUnsavedGuard: true });
  cur.format = /\.hwpx$/i.test(fileName) ? 'hwpx' : 'hwp';
  cur.origin = origin || 'hwp';
  cur.dir = filePath ? filePath.replace(/[\\/][^\\/]*$/, '') : null;
  ctx.setName(base);
  ctx.setSaveState?.('자동 복구 켜짐');
  ctx.setBadge(origin === 'docx' ? '워드 문서' : '한글 문서');
  ctx.toast(origin === 'docx'
    ? `워드 문서를 열었습니다 (${res.pageCount}쪽). 저장할 때는 파일 탭의 "워드로 저장"을 누르세요`
    : `문서를 열었습니다 (${res.pageCount}쪽)`);
  focusDoc();
  refreshEnabled();
  return true;
}

export async function showHwp() {
  ctx.setMode('hwp');
  try { await ensureStudio(); ctx.setSaveState?.('자동 복구 켜짐'); } catch (e) { console.error(e); ctx.toast('한글 편집기를 불러오지 못했습니다'); }
}

export function initHwp(context) {
  ctx = context;
  buildRibbon();
  // "한글에서 열어 보기"는 이 PC에 한글 프로그램이 있을 때만 보인다
  if (ctx.desktop) {
    ctx.desktop.hasHancom().then((yes) => {
      ribbonEl.querySelectorAll('[data-desktop-only]').forEach((b) => { b.hidden = !yes; });
    });
  }
  tabsEl.addEventListener('click', (e) => {
    const t = e.target.closest('[data-htab]');
    if (!t) return;
    tabsEl.querySelectorAll('[data-htab]').forEach((b) => b.classList.toggle('on', b === t));
    ribbonEl.querySelectorAll('.panel').forEach((p) => { p.hidden = p.dataset.hpanel !== t.dataset.htab; });
  });
  const onClick = (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.hcmd) runCommand(b.dataset.hcmd);
    else if (b.dataset.hact && ACTS[b.dataset.hact]) ACTS[b.dataset.hact]();
  };
  ribbonEl.addEventListener('click', onClick);
  $('#quickHwp')?.addEventListener('click', onClick);
  enabledTimer = setInterval(refreshEnabled, 1500);
  setInterval(autoRecover, 15000);
  // 창을 내리거나 닫기 직전에도 한 번 보관한다
  document.addEventListener('visibilitychange', () => { if (document.hidden) autoRecover(); });
  // 리본을 누르고 돌아왔을 때 단추 상태를 바로 맞춘다
  addEventListener('blur', () => setTimeout(refreshEnabled, 200));
  return { enabledTimer };
}
