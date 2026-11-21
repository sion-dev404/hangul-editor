// 공유마당 "공공 안심글꼴"(공공누리 제1유형)을 받아 이 프로그램에 넣을 글꼴 묶음을 만든다.
// 사용: node tools/fetch-fonts.mjs        (이미 받은 파일은 .font-cache 에서 다시 쓴다)
// 결과: public/fonts/kogl/*.woff, manifest.json, 출처표시.txt
//
// - 공공 안심글꼴 목록 페이지에서 글꼴별 압축 파일 주소와 이름·저작권자를 읽는다.
// - 압축을 풀어 ttf(없으면 otf)를 고르고, 글꼴 안의 이름표(name)에서 문서에 적히는 실제 이름을 읽는다.
// - 크기를 줄이려 WOFF(표마다 zlib 압축)로 바꾼다. 제1유형은 변형(2차적 저작물)을 허용한다.
// - 공공누리 제1유형의 조건인 출처 표시를 위해 글꼴·저작권자 목록을 함께 넣는다.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import JSZip from 'jszip';
import electronPath from 'electron';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'https://gongu.copyright.or.kr/gongu/singl/wrtContent/koglFont.do?menuNo=200324';
const BASE = 'https://gongu.copyright.or.kr/gongu/cmmn/file/';
const CACHE = path.join(ROOT, '.font-cache', 'kogl');
const OUT = path.join(ROOT, 'public', 'fonts', 'kogl');
const UA = { 'User-Agent': 'Mozilla/5.0 (hangul-editor font fetch)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 글꼴 이름표 읽기 (sfnt: ttf/otf) ---------- */
function tables(buf) {
  const n = buf.readUInt16BE(4); const out = {};
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    out[buf.toString('latin1', o, o + 4)] = { off: buf.readUInt32BE(o + 8), len: buf.readUInt32BE(o + 12), sum: buf.readUInt32BE(o + 4) };
  }
  return out;
}
function names(buf) {
  const t = tables(buf).name; if (!t) return {};
  const b = t.off; const count = buf.readUInt16BE(b + 2); const strOff = b + buf.readUInt16BE(b + 4);
  const res = {}; // res[nameID] = { ko, en, any }
  for (let i = 0; i < count; i++) {
    const r = b + 6 + i * 12;
    const plat = buf.readUInt16BE(r); const lang = buf.readUInt16BE(r + 4); const id = buf.readUInt16BE(r + 6);
    const len = buf.readUInt16BE(r + 8); const off = strOff + buf.readUInt16BE(r + 10);
    let s;
    if (plat === 3 || plat === 0) { s = ''; for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(buf.readUInt16BE(off + k)); }
    else if (plat === 1 && lang === 0) s = buf.toString('latin1', off, off + len);
    else continue;
    s = s.replace(/\0/g, '').trim(); if (!s) continue;
    const e = (res[id] ||= {});
    if (plat === 3 && lang === 0x0412) e.ko = s;
    else if (plat === 3 && lang === 0x0409) e.en ||= s;
    e.any ||= s;
  }
  return res;
}

/* ---------- WOFF 1.0 만들기 (표마다 zlib) ---------- */
// drop: 빼고 만들 표 이름들 (예: 깨진 kern 표)
function toWoff(buf, drop = []) {
  const tb = tables(buf); const tags = Object.keys(tb).filter((t) => !drop.includes(t)).sort();
  const parts = []; let off = 44 + 20 * tags.length; let sfntSize = 12 + 16 * tags.length;
  const dir = Buffer.alloc(20 * tags.length);
  tags.forEach((tag, i) => {
    const { off: o, len, sum } = tb[tag];
    const raw = buf.subarray(o, o + len);
    const z = zlib.deflateSync(raw, { level: 9 });
    const data = z.length < len ? z : raw;
    dir.write(tag, i * 20, 'latin1');
    dir.writeUInt32BE(off, i * 20 + 4); dir.writeUInt32BE(data.length, i * 20 + 8);
    dir.writeUInt32BE(len, i * 20 + 12); dir.writeUInt32BE(sum, i * 20 + 16);
    const pad = (4 - (data.length % 4)) % 4;
    parts.push(data, Buffer.alloc(pad)); off += data.length + pad;
    sfntSize += len + ((4 - (len % 4)) % 4);
  });
  const head = Buffer.alloc(44);
  head.write('wOFF', 0, 'latin1'); head.writeUInt32BE(buf.readUInt32BE(0), 4); head.writeUInt32BE(off, 8);
  head.writeUInt16BE(tags.length, 12); head.writeUInt32BE(sfntSize, 16); head.writeUInt16BE(1, 20);
  return Buffer.concat([head, dir, ...parts]);
}

// 이름표만 든 작은 SFNT (name·OS/2·head 표만). rhwp가 PC 글꼴 목록을 훑을 때는 이것만 읽는다.
function stubSfnt(buf) {
  const tb = tables(buf);
  const tags = ['OS/2', 'head', 'name'].filter((t) => tb[t]);
  let off = 12 + 16 * tags.length; const parts = [];
  const dir = Buffer.alloc(16 * tags.length);
  tags.forEach((t, i) => {
    const { off: o, len, sum } = tb[t];
    dir.write(t, i * 16, 'latin1'); dir.writeUInt32BE(sum, i * 16 + 4); dir.writeUInt32BE(off, i * 16 + 8); dir.writeUInt32BE(len, i * 16 + 12);
    const pad = (4 - (len % 4)) % 4;
    parts.push(buf.subarray(o, o + len), Buffer.alloc(pad)); off += len + pad;
  });
  const head = Buffer.alloc(12);
  head.writeUInt32BE(buf.readUInt32BE(0), 0); head.writeUInt16BE(tags.length, 4);
  return Buffer.concat([head, dir, ...parts]);
}

/* ---------- 목록 페이지 ---------- */
async function list() {
  const html = await (await fetch(PAGE, { headers: UA })).text();
  const out = []; const seen = new Set();
  const re = /<a[^>]*href="[^"]*?(fileDown\.do\?atchFileId=([0-9a-f]+)&(?:amp;)?fileSn=(\d+))"[^>]*>\s*<img[^>]*alt="([^"]*)"/g;
  for (const m of html.matchAll(re)) {
    const [, rel, id, sn, alt] = m;
    if (/내려받기/.test(alt) || seen.has(rel)) continue;
    seen.add(rel);
    const [label, owner = ''] = alt.split(/\s*,\s*저작권자\s*:\s*/);
    out.push({ url: BASE + rel.replace(/&amp;/g, '&'), id, sn, label: label.trim(), owner: owner.trim() });
  }
  return out;
}

async function main() {
  // 이미 만들어 두었으면 그대로 쓴다 (--force 로 다시 받기)
  if (fs.existsSync(path.join(OUT, 'manifest.json')) && !process.argv.includes('--force')) {
    console.log('글꼴 묶음이 이미 있습니다 (다시 받으려면 --force)');
    return;
  }
  fs.mkdirSync(CACHE, { recursive: true });
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const items = await list();
  console.log(`목록 ${items.length}개`);
  // --pick=파일 : 아직 안 받은 것 중에서 이 파일에 적힌 이름(한 줄에 하나, 앞부분만 맞아도 됨)만 받는다
  const pickArg = process.argv.find((a) => a.startsWith('--pick='));
  const picks = pickArg ? fs.readFileSync(pickArg.slice(7), 'utf8').split(/\r?\n/).map((s) => s.trim().replace(/\s+/g, '')).filter(Boolean) : null;
  const picked = (label) => !picks || picks.some((p) => label.replace(/\s+/g, '').startsWith(p));
  const CAND = path.join(ROOT, '.font-cache', 'cand');
  fs.rmSync(CAND, { recursive: true, force: true });
  fs.mkdirSync(CAND, { recursive: true });
  const faces = new Map(); let candNo = 0; let n = 0;
  for (const it of items) {
    n++;
    const zf = path.join(CACHE, `${it.id.slice(-12)}-${it.sn}.zip`);
    if (!fs.existsSync(zf) && !picked(it.label)) continue; // 고르지 않은 것은 받지 않는다
    if (!fs.existsSync(zf)) {
      for (let tryNo = 1; ; tryNo++) {
        try {
          const r = await fetch(it.url, { headers: UA });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          fs.writeFileSync(zf, Buffer.from(await r.arrayBuffer()));
          break;
        } catch (e) {
          if (tryNo >= 3) { console.log(`  건너뜀 ${it.label}: ${e.message}`); break; }
          await sleep(2000 * tryNo);
        }
      }
      await sleep(400); // 서버에 부담을 주지 않게 천천히
    }
    if (!fs.existsSync(zf)) continue;
    let zip;
    try { zip = await JSZip.loadAsync(fs.readFileSync(zf)); } catch { console.log(`  압축 오류 ${it.label}`); continue; }
    // 압축 안에 압축이 또 든 경우(예: 마포 글꼴의 *_ttf.zip)도 풀어서 함께 본다
    const files = [];
    const collect = async (z, depth) => {
      for (const f of Object.values(z.files)) {
        if (f.dir || /__MACOSX|(^|\/)\._/.test(f.name)) continue;
        if (/\.zip$/i.test(f.name) && depth < 2) {
          try { await collect(await JSZip.loadAsync(await f.async('uint8array')), depth + 1); } catch { /* 깨진 안쪽 압축은 건너뜀 */ }
        } else files.push(f);
      }
    };
    await collect(zip, 0);
    // 같은 글꼴의 otf·ttf를 둘 다 후보로 만든다. 글꼴마다 Chromium이 거부하는 쪽이 달라서,
    // 아래에서 실제 화면 엔진으로 열어 보고 되는 것 중 작은 쪽을 고른다.
    for (const f of files.filter((x) => /\.(otf|ttf)$/i.test(x.name))) {
      const buf = Buffer.from(await f.async('uint8array'));
      if (buf.length < 100 || buf.readUInt32BE(0) === 0x74746366) continue; // ttc 제외
      let nm; try { nm = names(buf); } catch { continue; }
      const fam = nm[1] || {}; const sub = nm[2] || {};
      const family = fam.ko || fam.any || it.label;
      const style = sub.en || sub.any || 'Regular';
      const key = `${family}|${style}`;
      let face = faces.get(key);
      if (!face) {
        const os2 = tables(buf)['OS/2'];
        face = {
          meta: {
            family,
            // 문서에는 한글 이름이나 영문 이름 어느 쪽으로도 적힐 수 있어 둘 다 별칭으로 둔다
            aliases: [...new Set([family, fam.en, nm[4]?.ko, nm[4]?.en].filter(Boolean))],
            ps: (nm[6]?.en || nm[6]?.any || '').replace(/\s+/g, '') || undefined, // PostScript 이름 (rhwp가 글꼴을 찾을 때 씀)
            label: it.label, owner: it.owner,
            bold: /bold/i.test(style), italic: /italic|oblique/i.test(style), weight: os2 ? buf.readUInt16BE(os2.off + 4) : 400,
            license: '공공누리 제1유형(출처표시)', source: PAGE,
          },
          cands: [],
        };
        faces.set(key, face);
      }
      if (face.cands.length >= 4) continue;
      const add = (woff, stripped) => {
        const cf = path.join(CAND, `c${String(candNo++).padStart(4, '0')}.woff`);
        fs.writeFileSync(cf, woff);
        fs.writeFileSync(cf.replace(/\.woff$/, '.head'), stubSfnt(buf));
        face.cands.push({ file: cf, stripped });
      };
      add(toWoff(buf), false);
      // 몇몇 글꼴은 표 하나가 깨져 Chromium이 글꼴 전체를 거부한다. 고친 판도 후보로 둔다 (원본이 안 열릴 때만 쓴다)
      //  - kern(글자 사이 간격)·DSIG(서명)·vhea/vmtx/VORG(세로쓰기 치수)는 빼도 가로 글은 그대로 그려진다
      //  - maxp 의 maxZones 가 0인 오래된 글꼴은 1로 고친다 (Chromium 글꼴 검사가 0을 거부)
      const tb = tables(buf);
      const drop = ['kern', 'DSIG', 'vhea', 'vmtx', 'VORG'].filter((t) => tb[t]);
      const fixed = Buffer.from(buf);
      let patched = false;
      if (tb.maxp && fixed.readUInt32BE(tb.maxp.off) === 0x00010000 && tb.maxp.len >= 16 && fixed.readUInt16BE(tb.maxp.off + 14) === 0) {
        fixed.writeUInt16BE(1, tb.maxp.off + 14); patched = true;
      }
      if (drop.length || patched) add(toWoff(fixed, drop), true);
    }
    if (n % 20 === 0) console.log(`  ${n}/${items.length} 처리, 글꼴 ${faces.size}종`);
  }

  // 실제 화면 엔진(Electron)으로 후보를 모두 열어 본다
  const all = [...faces.values()].flatMap((f) => f.cands.map((c) => c.file));
  const listFile = path.join(CAND, 'list.json'); const resFile = path.join(CAND, 'result.json');
  fs.writeFileSync(listFile, JSON.stringify(all));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(electronPath, [path.join(ROOT, 'tools', 'font-validate.cjs'), listFile, resFile], { env, stdio: 'inherit' });
  if (r.status !== 0 || !fs.existsSync(resFile)) throw new Error('글꼴 시험(Electron) 실패');
  const okSet = new Set(JSON.parse(fs.readFileSync(resFile, 'utf8')).map((ok, i) => (ok ? all[i] : null)).filter(Boolean));
  const fonts = []; let bytes = 0; const dropped = [];
  for (const face of faces.values()) {
    // 열리는 것 중 원본(표를 빼지 않은 것)을 먼저, 그다음 작은 것
    const good = face.cands.filter((c) => okSet.has(c.file))
      .sort((a, b) => (a.stripped - b.stripped) || (fs.statSync(a.file).size - fs.statSync(b.file).size));
    if (!good.length) { dropped.push(face.meta.family); continue; }
    const file = `f${String(fonts.length + 1).padStart(3, '0')}.woff`;
    fs.copyFileSync(good[0].file, path.join(OUT, file));
    fs.copyFileSync(good[0].file.replace(/\.woff$/, '.head'), path.join(OUT, file.replace(/\.woff$/, '.head')));
    bytes += fs.statSync(good[0].file).size;
    fonts.push({ ...face.meta, file });
  }
  if (dropped.length) console.log(`  화면 엔진이 열지 못해 뺀 글꼴 ${dropped.length}개: ${dropped.join(', ')}`);
  fonts.sort((a, b) => a.family.localeCompare(b.family, 'ko'));
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ made: new Date().toISOString(), source: PAGE, fonts }, null, 1));
  const notice = ['이 프로그램에 포함된 글꼴 (공공누리 제1유형: 출처표시)', `출처: 한국저작권위원회 공유마당 공공 안심글꼴 ${PAGE}`, '',
    ...fonts.map((f) => `- ${f.family}  ⓒ ${f.owner || '저작권자 표기 없음'}`)].join('\n');
  fs.writeFileSync(path.join(OUT, '출처표시.txt'), `${notice}\n`, 'utf8');
  console.log(`끝: 글꼴 ${fonts.length}개, ${(bytes / 1048576).toFixed(1)}MB → ${path.relative(ROOT, OUT)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
