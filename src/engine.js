// rhwp 엔진을 이 화면에서 직접 불러 쓴다 (한글 프로그램 없이 워드 화면 → 한글 문서 변환)
// 엔진 파일(rhwp_bg.wasm)은 편집기 본체(studio)와 같은 것을 같이 쓴다.
let ready = null;

function engine() {
  if (!ready) {
    ready = (async () => {
      if (!globalThis.measureTextWidth) {
        const c = document.createElement('canvas').getContext('2d');
        let last = '';
        globalThis.measureTextWidth = (font, text) => {
          if (font !== last) { c.font = font; last = font; }
          return c.measureText(text).width;
        };
      }
      const mod = await import('./vendor/rhwp-core.js');
      await mod.default({ module_or_path: new URL('./studio/assets/rhwp_bg.wasm', location.href) });
      return mod;
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const HU_PER_MM = 7200 / 25.4;
const PAGE_BREAK = /<div[^>]*class="page-break"[^>]*>\s*<\/div>/gi;

// 쪽 나누기 표시(div) → 바로 뒤 문단의 page-break-before. 뒤가 문단이 아니면(표 등) 빈 문단을 하나 둔다.
export function pageBreaksToCss(html) {
  return html.replace(new RegExp(`${PAGE_BREAK.source}\\s*(<p\\b[^>]*>)?`, 'gi'), (_m, p) => {
    if (!p) return '<p style="page-break-before:always"><br></p>';
    return /style="/i.test(p)
      ? p.replace(/style="/i, 'style="page-break-before:always;')
      : p.replace(/^<p/i, '<p style="page-break-before:always"');
  });
}

// 편집 화면의 HTML을 한글 문서(.hwp/.hwpx) 바이트로 만든다
// page: { orient: 'portrait'|'landscape', m: { t, b, l, r } (mm) }
export async function htmlToHwp(html, page, fmt = 'hwp') {
  const mod = await engine();
  const d = mod.HwpDocument.createEmpty();
  try {
    d.createBlankDocument();
    if (page) {
      const def = JSON.parse(d.getPageDef(0));
      def.landscape = page.orient === 'landscape';
      if (page.m) {
        def.marginTop = Math.round(page.m.t * HU_PER_MM);
        def.marginBottom = Math.round(page.m.b * HU_PER_MM);
        def.marginLeft = Math.round(page.m.l * HU_PER_MM);
        def.marginRight = Math.round(page.m.r * HU_PER_MM);
      }
      d.setPageDef(0, JSON.stringify(def));
    }
    // 쪽 나누기는 다음 문단의 "page-break-before"로 바꿔 한 번에 붙여 넣는다.
    // (나눠서 넣고 사이에 쪽 나누기를 끼우면, 그림으로 끝나는 문단에서 커서가 그림 앞에 놓여
    //  그림이 다음 쪽으로 밀리고 뒤 글이 그림 앞에 붙는 문제가 있었다)
    const r = JSON.parse(d.pasteHtml(0, 0, 0, pageBreaksToCss(html)));
    if (r.ok === false) throw new Error(r.error || '붙여 넣기 실패');
    return fmt === 'hwpx' ? d.exportHwpx() : d.exportHwp();
  } finally {
    try { d.free(); } catch { /* 무시 */ }
  }
}
