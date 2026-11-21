// 함께 넣은 공공누리 글꼴(public/fonts/kogl) 연결
// - 워드 화면: @font-face를 선언하고 글꼴 목록에 넣는다 (글꼴 파일은 실제로 쓸 때만 내려온다)
// - 한글 화면(rhwp): public/studio/kogl-hook.js(tools/studio-kogl-hook.js)와 tools/patch-studio.mjs가 맡는다
let packPromise = null;

export function loadFontPack() {
  packPromise ||= fetch(new URL('./fonts/kogl/manifest.json', location.href))
    .then((r) => (r.ok ? r.json() : null))
    .then((m) => (m?.fonts?.length ? m : null))
    .catch(() => null);
  return packPromise;
}

const fileUrl = (f) => new URL(`./fonts/kogl/${f.file}`, location.href).href;
const q = (s) => `'${String(s).replace(/['\\]/g, '')}'`;

// 글꼴마다 한글·영문 이름 모두로 쓸 수 있게 @font-face를 만든다
export function fontFaceCss(pack) {
  const out = [];
  for (const f of pack.fonts) {
    for (const name of f.aliases) {
      out.push(`@font-face{font-family:${q(name)};src:url('${fileUrl(f)}') format('woff');font-weight:${f.bold ? 700 : 400};font-style:${f.italic ? 'italic' : 'normal'};font-display:swap}`);
    }
  }
  return out.join('\n');
}

export function injectFontCss(doc, pack) {
  if (!doc || !pack || doc.getElementById('kogl-fonts')) return;
  const st = doc.createElement('style');
  st.id = 'kogl-fonts';
  st.textContent = fontFaceCss(pack);
  doc.head.append(st);
}

// 이름(별칭 포함)으로 묶음 안의 글꼴 찾기
export function findFonts(pack, families) {
  if (!pack) return [];
  const want = new Set([...families].map((s) => String(s).trim().toLowerCase()));
  return pack.fonts.filter((f) => f.aliases.some((a) => want.has(a.toLowerCase())));
}

// 공공누리 글꼴 묶음(optgroup)을 글꼴 상자 맨 아래에 붙인다 (워드 화면 기본 상자 모양 그대로)
export function addKoglGroup(select, pack) {
  if (!select || !pack || select.querySelector('optgroup[data-kogl]')) return;
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
