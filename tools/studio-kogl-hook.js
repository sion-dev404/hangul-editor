// rhwp 화면이 시작하기 전에, 바깥 편집기(부모 창)가 준비한 공공누리 글꼴을
// rhwp의 "PC 글꼴" 목록(queryLocalFonts)에 끼워 넣는다. rhwp는 시작할 때 글꼴 확인 방식을 정하므로
// 반드시 rhwp 본체보다 먼저 실행되어야 한다. (확장 CSP 때문에 인라인이 아닌 외부 파일로 둔다)
(function () {
  try {
    var p = window.parent;
    if (p && p !== window && p.__koglFonts && typeof p.__koglFonts.patch === 'function') p.__koglFonts.patch(window);
  } catch (e) { /* 다른 출처면 건드리지 않는다 */ }
}());
