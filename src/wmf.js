// 아주 작은 WMF(윈도 메타파일) 그리기 모듈.
// 한글 문서의 띠·깃발 같은 단순한 도형 그림을 PNG로 바꿔 워드에 넣을 때 쓴다.
// 선·다각형·사각형·둥근 사각형·타원·펜·붓을 그린다. 글자·비트맵이 든 레코드는 건너뛴다.

const CREATES = new Set([0x02fa, 0x02fc, 0x02fb, 0x00f7, 0x01f9, 0x0142, 0x06ff]);

export function parseWmf(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0; let inch = 0; let bbox = null;
  if (dv.getUint32(0, true) === 0x9ac6cdd7) {
    bbox = { l: dv.getInt16(6, true), t: dv.getInt16(8, true), r: dv.getInt16(10, true), b: dv.getInt16(12, true) };
    inch = dv.getUint16(14, true);
    p = 22;
  }
  p += dv.getUint16(p + 2, true) * 2;
  const recs = [];
  while (p + 6 <= bytes.length) {
    const size = dv.getUint32(p, true) * 2; const fn = dv.getUint16(p + 4, true);
    if (size < 6 || fn === 0 || p + size > bytes.length) break;
    recs.push({ fn, p: p + 6, n: (size - 6) / 2 });
    p += size;
  }
  return { dv, recs, bbox, inch };
}

const rgb = (dv, o) => `rgb(${dv.getUint8(o)},${dv.getUint8(o + 1)},${dv.getUint8(o + 2)})`;

// WMF를 그린 PNG 바이트를 돌려준다. 그릴 것이 없으면 null.
export async function wmfToPng(bytes, maxSide = 1400) {
  let w;
  try { w = parseWmf(bytes); } catch { return null; }
  const { dv, recs } = w;
  let org = { x: 0, y: 0 }; let ext = null;
  for (const r of recs) {
    if (r.fn === 0x020b) org = { y: dv.getInt16(r.p, true), x: dv.getInt16(r.p + 2, true) };
    if (r.fn === 0x020c && !ext) ext = { y: dv.getInt16(r.p, true), x: dv.getInt16(r.p + 2, true) };
  }
  if (!ext && w.bbox) { org = { x: w.bbox.l, y: w.bbox.t }; ext = { x: w.bbox.r - w.bbox.l, y: w.bbox.b - w.bbox.t }; }
  if (!ext || !ext.x || !ext.y) return null;
  const scale = maxSide / Math.max(Math.abs(ext.x), Math.abs(ext.y));
  const cw = Math.max(1, Math.round(Math.abs(ext.x) * scale)); const ch = Math.max(1, Math.round(Math.abs(ext.y) * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const g = canvas.getContext('2d');
  const sx = cw / ext.x; const sy = ch / ext.y;
  const X = (x) => (x - org.x) * sx; const Y = (y) => (y - org.y) * sy;

  const objs = [];
  let pen = { color: '#000', width: 1, none: false }; let brush = { color: '#fff', none: true };
  let cur = { x: 0, y: 0 }; let drawn = 0; let evenOdd = false;
  const place = (o) => { let i = objs.indexOf(null); if (i < 0) i = objs.length; objs[i] = o; };
  const paint = (fillIt = true) => {
    if (fillIt && !brush.none) { g.fillStyle = brush.color; g.fill(evenOdd ? 'evenodd' : 'nonzero'); }
    if (!pen.none) { g.strokeStyle = pen.color; g.lineWidth = Math.max(1, pen.width * Math.abs(sx)); g.stroke(); }
    drawn += 1;
  };
  const pts = (o, count) => { const a = []; for (let i = 0; i < count; i++) a.push([X(dv.getInt16(o + i * 4, true)), Y(dv.getInt16(o + i * 4 + 2, true))]); return a; };
  const path = (list, close) => { list.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); if (close) g.closePath(); };

  for (const r of recs) {
    const o = r.p;
    switch (r.fn) {
      case 0x02fa: { // CreatePenIndirect
        const style = dv.getUint16(o, true) & 0x0f;
        place({ kind: 'pen', none: style === 5, width: dv.getInt16(o + 2, true) || 1, color: rgb(dv, o + 6) });
        break;
      }
      case 0x02fc: { // CreateBrushIndirect
        const style = dv.getUint16(o, true);
        place({ kind: 'brush', none: style === 1, color: rgb(dv, o + 2) });
        break;
      }
      case 0x012d: { // SelectObject
        const ob = objs[dv.getUint16(o, true)];
        if (ob?.kind === 'pen') pen = ob; else if (ob?.kind === 'brush') brush = ob;
        break;
      }
      case 0x01f0: objs[dv.getUint16(o, true)] = null; break; // DeleteObject
      case 0x0106: evenOdd = dv.getUint16(o, true) === 1; break; // SetPolyFillMode (1=ALTERNATE)
      case 0x0214: cur = { y: dv.getInt16(o, true), x: dv.getInt16(o + 2, true) }; break; // MoveTo
      case 0x0213: { // LineTo
        const to = { y: dv.getInt16(o, true), x: dv.getInt16(o + 2, true) };
        g.beginPath(); g.moveTo(X(cur.x), Y(cur.y)); g.lineTo(X(to.x), Y(to.y)); paint(false); cur = to;
        break;
      }
      case 0x0324: case 0x0325: { // Polygon / Polyline
        const n = dv.getInt16(o, true);
        g.beginPath(); path(pts(o + 2, n), r.fn === 0x0324); paint(r.fn === 0x0324);
        break;
      }
      case 0x0538: { // PolyPolygon
        const np = dv.getUint16(o, true); let q = o + 2 + np * 2;
        g.beginPath();
        for (let i = 0; i < np; i++) { const n = dv.getUint16(o + 2 + i * 2, true); path(pts(q, n), true); q += n * 4; }
        paint(true);
        break;
      }
      case 0x041b: case 0x0418: case 0x061c: { // Rectangle / Ellipse / RoundRect
        const k = r.fn === 0x061c ? 4 : 0;
        const b = dv.getInt16(o + k, true); const rr = dv.getInt16(o + k + 2, true);
        const t = dv.getInt16(o + k + 4, true); const l = dv.getInt16(o + k + 6, true);
        const x0 = X(l); const y0 = Y(t); const x1 = X(rr); const y1 = Y(b);
        g.beginPath();
        if (r.fn === 0x0418) g.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
        else if (r.fn === 0x061c) {
          const rw = Math.abs(dv.getInt16(o + 2, true) * sx) / 2; const rh = Math.abs(dv.getInt16(o, true) * sy) / 2;
          g.roundRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0), Math.min(rw, rh));
        } else g.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
        paint(true);
        break;
      }
      default:
        if (CREATES.has(r.fn) && r.fn !== 0x02fa && r.fn !== 0x02fc) place({ kind: 'other' }); // 글꼴·팔레트 등도 번호 칸을 차지한다
    }
  }
  if (!drawn) return null;
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}
