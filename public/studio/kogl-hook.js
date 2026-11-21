// 공공누리 글꼴을 rhwp 한글 화면에 연결한다 (rhwp 본체보다 먼저 실행; 확장 CSP 때문에 외부 파일로 둔다)
// rhwp는 문서의 글꼴 이름을 "글꼴 이름 → 글꼴 파일" 표에서 찾아 그 파일을 CanvasKit으로 그린다.
// tools/patch-studio.mjs가 rhwp 코드에서 그 표를 처음 쓰는 곳에 window.__koglTn(표, 이름정리함수) 호출을 넣어 두었고,
// 여기서 공공누리 글꼴(public/fonts/kogl/manifest.json)을 그 표에 더한다. rhwp 기본 글꼴과 이름이 겹치면 rhwp 것을 둔다.
(function () {
  var fonts = [];
  try {
    var x = new XMLHttpRequest();
    x.open('GET', new URL('../fonts/kogl/manifest.json', location.href).href, false); // 표를 쓰기 전에 꼭 있어야 하므로 동기로 읽는다
    x.send();
    if (x.status === 200) fonts = (JSON.parse(x.responseText).fonts || []);
  } catch (e) { fonts = []; }
  window.__koglFonts = fonts;
  if (!fonts.length) return;

  // ---- 기본 그리기 방식(Canvas 2D) ----
  // 엔진은 Canvas에 '13px "제주명조", 대체글꼴…' 처럼 문서의 글꼴 이름을 맨 앞에 넘긴다.
  // 1) 공공누리 글꼴을 @font-face로 등록해 둔다 (선언만 하므로 쓰기 전에는 내려받지 않는다)
  // 2) Canvas가 그 이름을 처음 쓰는 순간 document.fonts.load()로 받는다
  // 3) 받기가 끝나면 rhwp가 document.fonts 'loadingdone'에서 글자 폭을 다시 재고 다시 그린다
  var names = new Map(); // 이름(소문자) → 글꼴들
  var css = [];
  fonts.forEach(function (f) {
    var url = new URL('../fonts/kogl/' + f.file, location.href).href;
    f.aliases.forEach(function (name) {
      var k = name.toLowerCase();
      if (!names.has(k)) names.set(k, []);
      names.get(k).push(f);
      css.push('@font-face{font-family:"' + name.replace(/["\\]/g, '') + '";src:url("' + url + '") format("woff");font-weight:' + (f.bold ? 700 : 400) + ';font-style:' + (f.italic ? 'italic' : 'normal') + ';font-display:block}');
    });
  });
  var addCss = function () {
    if (document.getElementById('kogl-font-faces')) return;
    var st = document.createElement('style');
    st.id = 'kogl-font-faces';
    st.textContent = css.join('\n');
    (document.head || document.documentElement).appendChild(st);
  };
  addCss();
  if (!document.head) document.addEventListener('DOMContentLoaded', addCss);

  // 인쇄 창(print.html): 페이지가 SVG 글자로 들어오므로 @font-face만 있으면 된다.
  // 다만 글꼴을 다 받기 전에 인쇄가 시작되지 않게 print()가 글꼴 준비를 기다리게 한다.
  if (/print\.html$/i.test(location.pathname) && typeof window.print === 'function') {
    var origPrint = window.print.bind(window);
    window.print = function () {
      var go = function () { origPrint(); };
      try {
        Promise.race([document.fonts.ready, new Promise(function (r) { setTimeout(r, 8000); })]).then(go, go);
      } catch (e) { go(); }
    };
  }

  // ---- 서식 줄 글꼴 메뉴(rhwp 모양 그대로): "공공누리" 분류와 표시 ----
  var families = [];
  var seenFam = new Set();
  fonts.forEach(function (f) { if (!seenFam.has(f.family)) { seenFam.add(f.family); families.push(f.family); } });
  window.__koglMenu = function () { return families.map(function (n) { return { value: n, label: n }; }); };
  var MARK = '<svg viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="4.3" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3 5.2l1.4 1.4L7.2 3.7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  window.__koglBadge = function (btn, value) {
    var list = typeof value === 'string' ? names.get(value.toLowerCase()) : null;
    if (!list) return;
    var label = btn.textContent;
    btn.textContent = '';
    btn.classList.add('kogl-opt');
    var n = document.createElement('span'); n.className = 'kogl-name'; n.textContent = label;
    var b = document.createElement('span'); b.className = 'kogl-badge'; b.innerHTML = MARK + '공공누리';
    btn.append(n, b);
    btn.title = label + '\n공공누리 제1유형 · 출처표시\n저작권자: ' + (list[0].owner || '');
  };
  css.push('.font-picker-option.kogl-opt{display:flex;align-items:center;gap:6px}' +
    '.kogl-opt .kogl-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}' +
    '.kogl-badge{flex:none;display:inline-flex;align-items:center;gap:2px;border:1px solid #2f6fd6;color:#2f6fd6;border-radius:3px;font-size:10px;font-weight:700;line-height:1;padding:2px 4px 2px 3px;background:#fff}' +
    '.kogl-badge svg{width:9px;height:9px;display:block}');
  var st0 = document.getElementById('kogl-font-faces');
  if (st0) st0.textContent = css.join('\n');

  // rhwp가 "쓸 수 있는 글꼴인가"를 물을 때 공공누리 글꼴이면 예 (tools/patch-studio.mjs가 넣은 호출)
  window.__koglHas = function (name) { return typeof name === 'string' && names.has(name.toLowerCase()); };

  var asked = new Set();
  var want = function (spec) {
    // spec 예: bold 13.333px "제주명조", 'Haansoft Batang', … , serif
    var px = spec.indexOf('px ');
    if (px < 0 || spec === last) return;
    last = spec;
    spec.slice(px + 3).split(',').forEach(function (part) {
      var fam = part.trim().replace(/^["']|["']$/g, '');
      var k = fam.toLowerCase();
      if (!fam || asked.has(k) || !names.has(k)) return;
      asked.add(k);
      var weights = new Set(names.get(k).map(function (f) { return f.bold ? '700' : '400'; }));
      weights.forEach(function (w) {
        document.fonts.load(w + ' 16px "' + fam.replace(/["\\]/g, '') + '"').catch(function () {});
      });
    });
  };
  var last = '';
  [window.CanvasRenderingContext2D, window.OffscreenCanvasRenderingContext2D].forEach(function (C) {
    if (!C) return;
    var d = Object.getOwnPropertyDescriptor(C.prototype, 'font');
    if (!d || !d.set) return;
    Object.defineProperty(C.prototype, 'font', {
      configurable: true, enumerable: d.enumerable,
      get: d.get,
      set: function (v) { if (typeof v === 'string') want(v); d.set.call(this, v); },
    });
  });

  // ---- CanvasKit 그리기 방식(주소에 ?renderer=canvaskit) ----

  var done = false;
  window.__koglTn = function (table, norm) {
    if (done || !fonts.length || !table || typeof table.set !== 'function') return;
    done = true;
    try {
      var groups = new Map();
      fonts.forEach(function (f) {
        var url = new URL('../fonts/kogl/' + f.file, location.href).href;
        f.aliases.forEach(function (name) {
          var key = norm(name);
          if (!key || table.has(key)) return;
          var g = groups.get(key);
          if (!g) { g = { face: name, sources: [] }; groups.set(key, g); }
          if (!g.sources.some(function (s) { return s.url === url; })) g.sources.push({ url: url, aliases: f.aliases.slice() });
        });
      });
      groups.forEach(function (g, key) {
        var plan = { sources: g.sources, unavailableFonts: [] };
        table.set(key, { sourceFace: g.face, declaredCapability: 'kogl', online: plan, offline: plan, ruleId: 'kogl.' + key });
      });
    } catch (e) { /* 실패해도 rhwp는 기본 글꼴로 계속 동작한다 */ }
  };
}());
