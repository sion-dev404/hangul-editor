// 아직 받지 않은 공공 안심글꼴 이름 보기 (목록 페이지만 한 번 읽고, 글꼴 파일은 받지 않는다)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.font-cache', 'kogl');
const PAGE = 'https://gongu.copyright.or.kr/gongu/singl/wrtContent/koglFont.do?menuNo=200324';
const html = await (await fetch(PAGE, { headers: { 'User-Agent': 'Mozilla/5.0 (hangul-editor font fetch)' } })).text();
const re = /<a[^>]*href="[^"]*?(fileDown\.do\?atchFileId=([0-9a-f]+)&(?:amp;)?fileSn=(\d+))"[^>]*>\s*<img[^>]*alt="([^"]*)"/g;
const have = new Set(fs.existsSync(CACHE) ? fs.readdirSync(CACHE) : []);
const seen = new Set(); const missing = [];
for (const [, rel, id, sn, alt] of html.matchAll(re)) {
  if (/내려받기/.test(alt) || seen.has(rel)) continue;
  seen.add(rel);
  if (!have.has(`${id.slice(-12)}-${sn}.zip`)) missing.push(alt.replace(/\s*,\s*저작권자\s*:\s*/, ' — ').trim());
}
console.log(`전체 ${seen.size}개 중 안 받은 것 ${missing.length}개`);
missing.forEach((m, i) => console.log(`${i + 1}. ${m}`));
