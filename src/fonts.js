// 함께 넣은 공공누리 글꼴(public/fonts/kogl) 연결
// - 워드 화면: @font-face를 선언하고 글꼴 목록에 넣는다 (글꼴 파일은 실제로 쓸 때만 내려온다)
// - 한글 화면(rhwp): 문서가 쓰는 글꼴만 미리 올려 rhwp가 "있는 글꼴"로 알아보게 한다
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

/* ---------- 한글 화면(rhwp) 연결 ----------
 * rhwp는 글자를 CanvasKit(Skia)으로 직접 그리고, PC 글꼴은 queryLocalFonts()로 글꼴 파일 원본(SFNT)
 * 바이트를 받아 쓴다. 그래서 rhwp 화면의 queryLocalFonts에 공공누리 글꼴을 PC 글꼴인 것처럼 끼워 넣는다.
 * - 목록만 훑을 때(이름 확인)는 이름표만 든 작은 파일(fNNN.head)을 준다
 * - 실제로 그릴 글꼴을 PostScript 이름으로 물을 때만 전체 글꼴(WOFF를 되돌린 SFNT)을 준다
 */
const sfntCache = new Map();
const headCache = new Map();

// WOFF 1.0 → SFNT(ttf/otf) 되돌리기
export async function woffToSfnt(ab) {
  const dv = new DataView(ab);
  if (dv.getUint32(0) !== 0x774f4646) return ab; // 'wOFF'가 아니면 그대로
  const flavor = dv.getUint32(4); const n = dv.getUint16(12);
  const ents = [];
  for (let i = 0; i < n; i++) {
    const o = 44 + i * 20;
    ents.push({ tag: dv.getUint32(o), off: dv.getUint32(o + 4), comp: dv.getUint32(o + 8), orig: dv.getUint32(o + 12), sum: dv.getUint32(o + 16) });
  }
  const datas = await Promise.all(ents.map(async (e) => {
    const raw = new Uint8Array(ab, e.off, e.comp);
    if (e.comp >= e.orig) return raw;
    const s = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }));
  let size = 12 + 16 * n;
  for (const e of ents) size += (e.orig + 3) & ~3;
  const out = new Uint8Array(size); const o = new DataView(out.buffer);
  let es = 0; while ((1 << (es + 1)) <= n) es++;
  o.setUint32(0, flavor); o.setUint16(4, n); o.setUint16(6, (1 << es) * 16); o.setUint16(8, es); o.setUint16(10, n * 16 - (1 << es) * 16);
  let pos = 12 + 16 * n;
  ents.forEach((e, i) => {
    o.setUint32(12 + i * 16, e.tag); o.setUint32(16 + i * 16, e.sum); o.setUint32(20 + i * 16, pos); o.setUint32(24 + i * 16, e.orig);
    out.set(datas[i].subarray(0, e.orig), pos);
    pos += (e.orig + 3) & ~3;
  });
  return out.buffer;
}

const sfntBlob = (f) => {
  if (!sfntCache.has(f.file)) {
    sfntCache.set(f.file, fetch(fileUrl(f)).then((r) => r.arrayBuffer()).then(woffToSfnt).then((b) => new Blob([b], { type: 'font/sfnt' })));
  }
  return sfntCache.get(f.file);
};
const psName = (f) => f.ps || `KOGL-${f.file.replace(/\W/g, '')}`;

// rhwp는 "있는 글꼴인가"를 화면에 실제로 올라간 글꼴로 판단한다 → 문서가 쓰는 글꼴만 올린다
const preloaded = new Set();
export async function preloadFonts(doc, fonts) {
  let added = 0;
  for (const f of fonts) {
    if (preloaded.has(f.file)) continue;
    preloaded.add(f.file);
    for (const name of f.aliases) {
      try {
        const face = new doc.defaultView.FontFace(name, `url('${fileUrl(f)}') format('woff')`, { weight: f.bold ? '700' : '400', style: f.italic ? 'italic' : 'normal' });
        await face.load();
        doc.fonts.add(face);
        added++;
      } catch { /* 하나 실패해도 나머지는 계속 */ }
    }
  }
  return added > 0;
}

const headBlob = (f) => {
  if (!headCache.has(f.file)) {
    headCache.set(f.file, fetch(fileUrl(f).replace(/\.woff$/, '.head')).then((r) => (r.ok ? r.blob() : sfntBlob(f))));
  }
  return headCache.get(f.file);
};

// rhwp 화면(window)의 queryLocalFonts를 감싸 공공누리 글꼴을 더한다 (rhwp 시작 전에, 한 번만)
export function patchLocalFonts(win) {
  if (!win || win.__koglPatched) return;
  win.__koglPatched = true;
  const orig = typeof win.queryLocalFonts === 'function' ? win.queryLocalFonts.bind(win) : null;
  win.queryLocalFonts = async (opts = {}) => {
    let sys = [];
    if (orig) { try { sys = await orig(opts); } catch { sys = []; } }
    const pack = await loadFontPack();
    if (!pack) return sys;
    const wanted = Array.isArray(opts.postscriptNames) ? new Set(opts.postscriptNames) : null;
    const extra = [];
    for (const f of pack.fonts) {
      const ps = psName(f);
      if (wanted && !wanted.has(ps)) continue;
      // 그릴 때(이름으로 콕 집어 물을 때)는 전체 글꼴, 목록을 훑을 때는 이름표만
      const blob = wanted ? () => sfntBlob(f) : () => headBlob(f);
      for (const alias of f.aliases) extra.push({ family: alias, fullName: alias, postscriptName: ps, style: f.bold ? 'Bold' : 'Regular', blob });
    }
    return [...sys, ...extra];
  };
}
