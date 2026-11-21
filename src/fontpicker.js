// 글꼴 고르기 목록 (워드 화면 #fontSel, 한글 화면 rhwp #font-name 공용)
// 기본 <select> 목록에는 그림을 넣을 수 없어, 상자를 누르면 직접 만든 목록을 띄운다.
// 공공누리 글꼴에는 "공공누리" 표시를 붙인다. 고르면 원래 상자의 값을 바꾸고 change를 보낸다(기존 동작 그대로).
// 키보드로 상자를 다루는 기본 동작은 그대로 둔다.

const CSS = `
.kfp{position:fixed;z-index:2147483000;box-sizing:border-box;background:#fff;border:1px solid #c5cbd4;border-radius:6px;
  box-shadow:0 8px 28px rgba(20,30,50,.18);overflow:auto;overscroll-behavior:contain;padding:0 0 4px;
  font:13px/1.35 "Malgun Gothic","맑은 고딕",sans-serif;color:#1d2430;min-width:250px}
.kfp-h{position:sticky;top:0;z-index:1;background:#f1f3f6;border-bottom:1px solid #e1e5ea;color:#5b6575;
  font-size:11.5px;font-weight:700;padding:6px 10px;display:flex;align-items:center;gap:6px}
.kfp-i{display:flex;align-items:center;gap:8px;padding:6px 10px;cursor:pointer;white-space:nowrap}
.kfp-i:hover{background:#eaf1fd}
.kfp-i.sel{background:#d7e5fc;font-weight:700}
.kfp-n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.kfp-b{flex:none;display:inline-flex;align-items:center;gap:3px;border:1px solid #2f6fd6;color:#2f6fd6;background:#fff;
  border-radius:3px;font-size:10px;font-weight:700;line-height:1;padding:2px 4px 2px 3px;letter-spacing:-.02em}
.kfp-b svg{width:9px;height:9px;display:block}
.kfp-i.sel .kfp-b{background:#fff}
.kfp-x{position:sticky;bottom:-4px;background:#f7f8fa;border-top:1px solid #e1e5ea;color:#2f6fd6;font-weight:700;
  padding:8px 10px;margin-bottom:-4px;cursor:pointer;text-align:center}
.kfp-x:hover{background:#eaf1fd}
`;

// 직접 그린 작은 표시(원 안의 체크) + "공공누리" 글자
const MARK_SVG = '<svg viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="4.3" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3 5.2l1.4 1.4L7.2 3.7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
export const koglBadgeHtml = (title = '') => `<span class="kfp-b" title="${esc(title)}">${MARK_SVG}공공누리</span>`;

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

function ensureCss(doc) {
  if (doc.getElementById('kfp-css')) return;
  const st = doc.createElement('style');
  st.id = 'kfp-css';
  st.textContent = CSS;
  doc.head.append(st);
}

// pack: loadFontPack() 결과. 공공누리 글꼴 이름(모든 별칭) → 정보
function koglIndex(pack) {
  const m = new Map();
  for (const f of pack?.fonts || []) for (const a of f.aliases) if (!m.has(a.toLowerCase())) m.set(a.toLowerCase(), f);
  return m;
}

// 공공누리 글꼴 묶음(optgroup)을 상자에 붙인다. 이미 있으면 그대로 둔다.
export function addKoglGroup(select, pack) {
  if (!pack || select.querySelector('optgroup[data-kogl]')) return;
  const doc = select.ownerDocument;
  const g = doc.createElement('optgroup');
  g.dataset.kogl = '1';
  const fams = [...new Set(pack.fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b, 'ko'));
  g.label = `공공누리 글꼴 (${fams.length})`;
  for (const fam of fams) {
    const o = doc.createElement('option');
    o.value = fam; o.textContent = fam;
    g.append(o);
  }
  select.append(g);
}

// opts.more: { label } — 목록 맨 아래에 "원래 메뉴 열기" 항목을 둔다(한글 화면: rhwp의 분류별 메뉴, PC 글꼴 포함)
export function attachFontPicker(select, pack, opts = {}) {
  if (!select || select.dataset.kfp) return;
  select.dataset.kfp = '1';
  const doc = select.ownerDocument;
  const win = doc.defaultView;
  const kogl = koglIndex(pack);
  let pop = null;

  const close = () => {
    if (!pop) return;
    pop.remove(); pop = null;
    doc.removeEventListener('mousedown', outside, true);
    win.removeEventListener('resize', close);
    win.removeEventListener('blur', close);
    doc.removeEventListener('scroll', onScroll, true);
  };
  const outside = (e) => { if (pop && !pop.contains(e.target) && e.target !== select) close(); };
  const onScroll = (e) => { if (pop && !pop.contains(e.target)) close(); };

  const itemHtml = (o) => {
    const f = kogl.get(o.value.toLowerCase());
    const badge = f ? koglBadgeHtml(`공공누리 제1유형 · 출처표시\n저작권자: ${f.owner || ''}`) : '';
    return `<div class="kfp-i${o.value === select.value ? ' sel' : ''}" data-v="${esc(o.value)}"><span class="kfp-n">${esc(o.textContent || o.value)}</span>${badge}</div>`;
  };

  const open = () => {
    ensureCss(doc);
    // rhwp 자체 메뉴가 열려 있으면 닫는다(rhwp는 상자에서 Escape를 받으면 닫는다)
    select.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    // 묶음 없는 글꼴(기본 목록·문서에서 쓰인 글꼴)은 처음 나온 자리에 "글꼴" 한 묶음으로 모은다
    const sections = [];
    let loose = null;
    for (const ch of select.children) {
      if (ch.tagName === 'OPTGROUP') {
        sections.push({ label: ch.label, kogl: !!ch.dataset.kogl, opts: [...ch.children] });
      } else if (ch.tagName === 'OPTION') {
        if (!loose) { loose = { label: '글꼴', kogl: false, opts: [] }; sections.push(loose); }
        loose.opts.push(ch);
      }
    }
    let html = '';
    for (const s of sections) {
      if (!s.opts.length) continue;
      html += `<div class="kfp-h">${esc(s.label)}${s.kogl ? koglBadgeHtml('공공누리 제1유형: 출처를 표시하면 상업적 이용·변경 가능') : ''}</div>`;
      for (const o of s.opts) html += itemHtml(o);
    }
    if (opts.more) html += `<div class="kfp-x" data-more="1">${esc(opts.more.label)}</div>`;
    pop = doc.createElement('div');
    pop.className = 'kfp';
    pop.innerHTML = html;
    doc.body.append(pop);

    const r = select.getBoundingClientRect();
    const vw = win.innerWidth, vh = win.innerHeight;
    const w = Math.max(r.width, 260);
    const below = vh - r.bottom - 8, above = r.top - 8;
    const maxH = Math.min(460, Math.max(below, above));
    pop.style.width = `${w}px`;
    pop.style.maxHeight = `${maxH}px`;
    pop.style.left = `${Math.max(4, Math.min(r.left, vw - w - 4))}px`;
    const h = Math.min(pop.scrollHeight, maxH);
    pop.style.top = below >= h || below >= above ? `${r.bottom + 2}px` : `${r.top - h - 2}px`;

    pop.querySelector('.kfp-i.sel')?.scrollIntoView({ block: 'center' });
    // 목록을 눌러도 편집 화면의 커서·선택이 그대로 있게 한다
    pop.addEventListener('mousedown', (e) => e.preventDefault());
    pop.addEventListener('click', (e) => {
      if (e.target.closest('.kfp-x')) {
        close();
        // 이번 한 번은 가로채지 않고 원래 상자(rhwp)가 처리하게 한다
        bypass = true;
        try {
          select.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
        } finally { bypass = false; }
        return;
      }
      const it = e.target.closest('.kfp-i');
      if (!it) return;
      const v = it.dataset.v;
      close();
      if (select.value !== v) {
        select.value = v;
        select.dispatchEvent(new win.Event('input', { bubbles: true }));
        select.dispatchEvent(new win.Event('change', { bubbles: true }));
      }
    });
    doc.addEventListener('mousedown', outside, true);
    win.addEventListener('resize', close);
    win.addEventListener('blur', close);
    doc.addEventListener('scroll', onScroll, true);
  };

  // 문서 전체에서 먼저(capture) 받아, 기본 목록이나 rhwp 자체 글꼴 메뉴 대신 이 목록을 띄운다.
  // rhwp는 pointerdown을 막고(그러면 mousedown이 생기지 않는다) click에서 자기 메뉴를 열므로 셋 다 가로챈다.
  let lastToggle = 0;
  let bypass = false;
  const toggle = (e) => {
    if (bypass || e.target !== select || (e.button !== undefined && e.button !== 0) || select.disabled) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'click') return; // 열고 닫기는 누를 때 이미 했다
    const now = Date.now();
    if (now - lastToggle < 400) return; // pointerdown 뒤에 오는 mousedown은 한 번으로 친다
    lastToggle = now;
    if (pop) close(); else open();
  };
  doc.addEventListener('pointerdown', toggle, true);
  doc.addEventListener('mousedown', toggle, true);
  doc.addEventListener('click', toggle, true);
}
