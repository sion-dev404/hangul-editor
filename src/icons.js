// 리본 단추에 쓰는 아이콘 (이 프로그램을 위해 직접 그린 단순한 그림)
// 32x32 칸에 파란 선 + 연한 면 + 포인트 색으로 그린다.
const B = '#2b5fa8'; // 선
const L = '#d6e6fa'; // 연한 면
const A = '#f0a030'; // 포인트
const G = '#5aa469'; // 초록 포인트

const svg = (body) => `<svg viewBox="0 0 32 32" width="28" height="28" fill="none" stroke="${B}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const page = (extra = '') => `<path d="M8 3h11l6 6v20H8z" fill="#fff"/><path d="M19 3v6h6" fill="${L}"/>${extra}`;
const lines = (y0, n, x0 = 11, x1 = 22) => Array.from({ length: n }, (_, i) => `<path d="M${x0} ${y0 + i * 3.4}H${x1}"/>`).join('');

export const ICONS = {
  doc: svg(page(lines(15, 4))),
  docw: svg(page(`<path d="M10.5 15l2 9 2-6 2 6 2-9" stroke="${A}"/>`)),
  open: svg(`<path d="M4 9h8l2 3h14v14H4z" fill="${L}"/><path d="M4 26l4-10h22l-4 10z" fill="#fff"/>`),
  save: svg(`<path d="M5 5h17l5 5v17H5z" fill="${L}"/><path d="M10 5v7h10V5"/><rect x="9" y="18" width="14" height="9" fill="#fff"/>`),
  pdf: svg(page(`<text x="9.5" y="25" font-size="8" font-weight="700" fill="${A}" stroke="none" font-family="sans-serif">PDF</text>`)),
  print: svg(`<path d="M9 12V5h14v7"/><rect x="4" y="12" width="24" height="11" rx="2" fill="${L}"/><rect x="9" y="19" width="14" height="9" fill="#fff"/><circle cx="24" cy="16" r="1" fill="${A}" stroke="none"/>`),
  paste: svg(`<rect x="5" y="6" width="16" height="21" rx="2" fill="${L}"/><rect x="10" y="3" width="6" height="5" rx="1" fill="#fff"/><path d="M17 13h10v16H17z" fill="#fff"/><path d="M19 18h6M19 21.5h6M19 25h4"/>`),
  style: svg(`<path d="M6 25L14 5l8 20M9 18h10" /><path d="M20 24h8" stroke="${A}"/><path d="M22 28h6" stroke="${A}"/>`),
  find: svg(`<circle cx="13" cy="13" r="8" fill="${L}"/><path d="M19 19l9 9" stroke-width="3"/>`),
  replace: svg(`<path d="M6 12h17l-4-4M26 20H9l4 4"/><rect x="4" y="3" width="3" height="3" fill="${A}" stroke="none"/>`),
  table: svg(`<rect x="4" y="6" width="24" height="20" fill="#fff"/><path d="M4 6h24v6H4z" fill="${L}"/><path d="M4 12h24M4 19h24M13 6v20M21 6v20"/>`),
  image: svg(`<rect x="4" y="6" width="24" height="20" rx="2" fill="${L}"/><circle cx="11" cy="13" r="2.5" fill="${A}" stroke="none"/><path d="M5 25l8-8 5 5 4-4 6 6" fill="#fff"/>`),
  shape: svg(`<circle cx="12" cy="12" r="7" fill="${L}"/><path d="M14 17h13v10H14z" fill="#fff"/><path d="M22 4l5 8h-10z" fill="${A}" stroke="none"/>`),
  textbox: svg(`<rect x="4" y="6" width="24" height="20" rx="2" fill="#fff"/><path d="M10 13h12M16 13v9"/>`),
  symbol: svg(`<rect x="4" y="4" width="24" height="24" rx="3" fill="${L}"/><path d="M16 9v14M9.5 12.5l13 7M22.5 12.5l-13 7" stroke="${A}"/>`),
  equation: svg(`<path d="M24 7H10l8 9-8 9h14" fill="${L}"/>`),
  gear: svg(`<circle cx="16" cy="16" r="5" fill="${L}"/><path d="M16 3v4M16 25v4M3 16h4M25 16h4M7 7l3 3M22 22l3 3M25 7l-3 3M10 22l-3 3"/>`),
  border: svg(`<rect x="5" y="5" width="22" height="22" fill="#fff"/><path d="M5 16h22M16 5v22" stroke-dasharray="2 2"/><path d="M5 5h22v22H5z" stroke-width="2.6"/>`),
  pagesetup: svg(`<path d="M7 3h18v26H7z" fill="#fff"/><path d="M11 3v26M7 8h18" stroke="${A}" stroke-dasharray="2 2"/>`),
  pagebreak: svg(`<path d="M7 3h18v10H7z" fill="${L}"/><path d="M7 19h18v10H7z" fill="#fff"/><path d="M3 16h26" stroke="${A}" stroke-dasharray="3 2"/>`),
  zoomout: svg(`<circle cx="13" cy="13" r="8" fill="${L}"/><path d="M19 19l9 9M9 13h8" stroke-width="2"/>`),
  zoomin: svg(`<circle cx="13" cy="13" r="8" fill="${L}"/><path d="M19 19l9 9M9 13h8M13 9v8" stroke-width="2"/>`),
  zoom100: svg(`<circle cx="13" cy="13" r="8" fill="${L}"/><path d="M19 19l9 9"/><text x="8.5" y="16.5" font-size="8" font-weight="700" fill="${B}" stroke="none" font-family="sans-serif">1:1</text>`),
  zoomfit: svg(`<rect x="3" y="9" width="26" height="14" fill="${L}"/><path d="M3 16h26M7 12l-4 4 4 4M25 12l4 4-4 4"/>`),
  pages1: svg(`<rect x="10" y="4" width="12" height="24" fill="#fff"/>${'<path d="M13 9h6M13 12.5h6M13 16h6"/>'}`),
  pages2: svg(`<rect x="3" y="6" width="12" height="20" fill="#fff"/><rect x="17" y="6" width="12" height="20" fill="#fff"/><path d="M6 11h6M6 14h6M20 11h6M20 14h6"/>`),
  pages3: svg(`<rect x="2" y="8" width="8.5" height="16" fill="#fff"/><rect x="11.75" y="8" width="8.5" height="16" fill="#fff"/><rect x="21.5" y="8" width="8.5" height="16" fill="#fff"/><path d="M4 12h4.5M13.75 12h4.5M23.5 12h4.5" stroke="${A}"/>`),
  pagesmany: svg(`<rect x="3" y="3" width="11" height="12" fill="#fff"/><rect x="18" y="3" width="11" height="12" fill="#fff"/><rect x="3" y="17" width="11" height="12" fill="#fff"/><rect x="18" y="17" width="11" height="12" fill="${L}"/>`),
  zoomfitpage: svg(`<rect x="9" y="3" width="14" height="26" fill="${L}"/><path d="M3 3h5M3 3v5M29 29h-5M29 29v-5M29 3h-5M29 3v5M3 29h5M3 29v-5"/>`),
  peek: svg(`<circle cx="14" cy="14" r="8" fill="${L}"/><path d="M20 20l8 8"/><path d="M10 14l3 3 5-6" stroke="${G}" stroke-width="2"/>`),
  date: svg(`<rect x="4" y="7" width="24" height="21" rx="2" fill="#fff"/><path d="M4 7h24v6H4z" fill="${L}"/><path d="M10 4v5M22 4v5"/><path d="M9 18h4M15 18h4M21 18h2M9 23h4M15 23h4" stroke="${A}"/>`),
  hline: svg(`<path d="M3 16h26" stroke-width="2.6"/><path d="M8 8h16M8 24h16" stroke-dasharray="2 3"/>`),
  portrait: svg(`<rect x="8" y="3" width="16" height="26" fill="${L}"/><path d="M12 10h8M12 14h8M12 18h5"/>`),
  landscape: svg(`<rect x="3" y="8" width="26" height="16" fill="${L}"/><path d="M8 13h16M8 17h16M8 21h8"/>`),
  marginnarrow: svg(`<rect x="6" y="3" width="20" height="26" fill="#fff"/><rect x="8" y="5" width="16" height="22" fill="${L}"/>`),
  marginnormal: svg(`<rect x="6" y="3" width="20" height="26" fill="#fff"/><rect x="10" y="7" width="12" height="18" fill="${L}"/>`),
  marginwide: svg(`<rect x="6" y="3" width="20" height="26" fill="#fff"/><rect x="12" y="9" width="8" height="14" fill="${L}"/>`),
  guides: svg(`<path d="M5 10h22M5 22h22" stroke-dasharray="3 2"/><rect x="9" y="12" width="14" height="8" fill="${L}"/>`),
  trash: svg(`<path d="M8 9h16l-1.5 19h-13z" fill="${L}"/><path d="M5 9h22M12 9V5h8v4M13 14v10M19 14v10"/>`),
  header: svg(`<rect x="6" y="3" width="20" height="26" fill="#fff"/><rect x="6" y="3" width="20" height="7" fill="${L}"/><path d="M10 15h12M10 19h12M10 23h8"/>`),
  footer: svg(`<rect x="6" y="3" width="20" height="26" fill="#fff"/><rect x="6" y="22" width="20" height="7" fill="${L}"/><path d="M10 8h12M10 12h12M10 16h8"/>`),
  pagenum: svg(`<rect x="6" y="3" width="20" height="26" fill="#fff"/><text x="12" y="26" font-size="9" font-weight="700" fill="${A}" stroke="none" font-family="sans-serif">1</text><path d="M10 8h12M10 12h12M10 16h8"/>`),
  undo: svg(`<path d="M10 11H20a6 6 0 010 12H12"/><path d="M14 6l-5 5 5 5"/>`),
  redo: svg(`<path d="M22 11H12a6 6 0 000 12H20"/><path d="M18 6l5 5-5 5"/>`),
  openhwp: svg(`<circle cx="14" cy="14" r="8" fill="${L}"/><path d="M20 20l8 8"/><text x="9.5" y="17.5" font-size="9" font-weight="700" fill="${A}" stroke="none" font-family="sans-serif">한</text>`),
  // 클라우드
  cloudup: svg(`<path d="M9 24h15a5 5 0 0 0 .6-10A7.5 7.5 0 0 0 10 12.5 5.8 5.8 0 0 0 9 24z" fill="${L}"/><path d="M16 27V16M12 19.5l4-4 4 4" stroke="${A}"/>`),
  cloudopen: svg(`<path d="M9 22h15a5 5 0 0 0 .6-10A7.5 7.5 0 0 0 10 10.5 5.8 5.8 0 0 0 9 22z" fill="${L}"/><path d="M13.5 26.5l-1.2 1.2a3 3 0 0 1-4.2-4.2l2.4-2.4a3 3 0 0 1 4.2 0M18.5 22.5l1.2-1.2a3 3 0 0 1 4.2 4.2l-2.4 2.4a3 3 0 0 1-4.2 0" stroke="${A}"/>`),
  share: svg(`<circle cx="23" cy="8" r="3.5" fill="${L}"/><circle cx="9" cy="16" r="3.5" fill="${L}"/><circle cx="23" cy="24" r="3.5" fill="${L}"/><path d="M12 14.3l8-4.6M12 17.7l8 4.6" stroke="${A}"/>`),
  mydocs: svg(`<path d="M4 9h9l2 3h13v14H4z" fill="${L}"/><path d="M4 12h24"/><path d="M11 20h10M11 23h7" stroke="${A}"/>`),
  user: svg(`<circle cx="16" cy="11" r="5.5" fill="${L}"/><path d="M6 27c1.5-5.5 5.5-8 10-8s8.5 2.5 10 8z" fill="${L}"/><path d="M21 22l2 2 4-4" stroke="${A}"/>`),
  history: svg(`<circle cx="17" cy="16" r="10" fill="${L}"/><path d="M17 10v6l4 3"/><path d="M5 11l2 5 4.5-2.5" stroke="${A}"/>`),
};

// 이름이면 아이콘, 아니면(기호 문자) 그대로 돌려준다
export const icon = (name) => ICONS[name] || name;
