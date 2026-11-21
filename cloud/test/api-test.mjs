// 클라우드 서버 API·보안 시험: node cloud/test/api-test.mjs [서버주소]
// (wrangler dev + .dev.vars의 DEV_LOGIN=1 이 필요. 배포본에는 가짜 로그인이 없다)
import { createHash, randomBytes } from 'node:crypto';
const API = process.argv[2] || 'http://127.0.0.1:8787';
const ORIGIN = 'http://localhost:5199';
let fail = 0;
const ok = (c, m) => { console.log(`${c ? '통과' : '실패'}  ${m}`); if (!c) fail++; };
const req = (path, opt = {}, token) => fetch(API + path, { redirect: 'manual', ...opt, headers: { Origin: ORIGIN, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opt.headers || {}) } });
const b64u = (b) => Buffer.from(b).toString('base64url');

// 가짜 로그인 (Google 대신) → 1회용 코드 → 세션
async function login(email, ret = ORIGIN, badVerifier = false) {
  const verifier = b64u(randomBytes(32));
  const challenge = b64u(createHash('sha256').update(verifier).digest());
  const r = await req(`/auth/dev/start?challenge=${challenge}&ret=${encodeURIComponent(ret)}&email=${encodeURIComponent(email)}`);
  let code;
  if (r.status === 302) code = new URL(r.headers.get('Location')).searchParams.get('code');
  else code = /code:"([^"]+)"/.exec(await r.text())?.[1];
  const x = await req('/api/auth/exchange', { method: 'POST', body: JSON.stringify({ code, verifier: badVerifier ? b64u(randomBytes(32)) : verifier }) });
  return { status: x.status, ...(await x.json()), code, ret: r.status === 302 ? r.headers.get('Location') : null };
}

ok((await req('/api/docs', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status === 403, '허용 안 된 사이트에서 거절');
ok((await req('/api/docs', { method: 'POST' })).status === 401, '로그인 없이 만들기 거절');

const bad = await login('a@test.kr', ORIGIN, true);
ok(bad.status === 400 && !bad.token, '1회용 코드를 훔쳐도 비밀값(verifier) 없이는 로그인 불가');
const evil = await req(`/auth/dev/start?challenge=${'a'.repeat(43)}&ret=${encodeURIComponent('https://evil.example')}&email=x@y.kr`);
ok(/잘못된 로그인 요청/.test(await evil.text()), '허용 안 된 곳으로 로그인 결과 보내기 거절');
const desk = await login('d@test.kr', 'http://127.0.0.1:47615');
ok(desk.token && /^http:\/\/127\.0\.0\.1:47615\/__auth\?code=/.test(desk.ret), '설치형 로그인: 내장 서버로 코드 전달');

const A = await login('a@test.kr');
const B = await login('b@test.kr');
const C = await login('c@test.kr');
ok(A.token && B.token && C.token && A.user.email === 'a@test.kr', '철수(A)·영희(B)·민수(C) 로그인');
const me = await (await req('/api/me', {}, A.token)).json();
ok(me.email === 'a@test.kr', '/api/me 로 내 정보');
const forged = A.token.split('.'); forged[1] = b64u(JSON.stringify({ sub: 'x', email: 'a@test.kr', name: 'x', exp: Date.now() + 1e9 }));
ok((await req('/api/me', {}, forged.join('.'))).status === 401, '위조한 세션 표 거절');
ok((await req('/api/me', {}, A.code)).status === 401, '1회용 코드를 세션 표로 쓰기 거절');

const c = await (await req('/api/docs', { method: 'POST' }, A.token)).json();
ok(!!c.id, `A 문서 만들기 (${c.id})`);
const D = `/api/docs/${c.id}`;

const ws = new WebSocket(API.replace(/^http/, 'ws') + D + '/live', { headers: { Origin: ORIGIN } });
const events = [];
ws.onmessage = (e) => events.push(JSON.parse(e.data));
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

const l1 = await (await req(D + '/lock', { method: 'POST', body: JSON.stringify({ by: 'A' }) }, A.token)).json();
ok(!!l1.lockId, 'A 편집 잠금');
const body = new Uint8Array(1000).map((_, i) => i % 251);
const p1 = await (await req(D, { method: 'PUT', headers: { 'X-Lock-Id': l1.lockId, 'X-Author': 'A' }, body }, A.token)).json();
ok(p1.n === 1, 'A 버전 1 저장');

ok((await req(D + '/lock', { method: 'POST', body: '{}' })).status === 401, '로그인 안 한 사람 잠금 거절');
ok((await req(D + '/lock', { method: 'POST', body: '{}', headers: { 'X-User': 'a@test.kr' } })).status === 401, '주인 이메일을 머리글로 속여도 거절');
ok((await req(D + '/lock', { method: 'POST', body: '{}' }, C.token)).status === 403, '권한 없는 C 잠금 거절');
ok((await req(D, { method: 'PUT', body }, C.token)).status === 403, '권한 없는 C 저장 거절');
ok((await req(D + '/editors', { method: 'PUT', body: JSON.stringify({ editors: ['c@test.kr'] }) }, C.token)).status === 403, 'C가 자기를 편집자로 넣기 거절');

const anonInfo = await (await req(D)).json();
ok(anonInfo.versions.length === 1 && anonInfo.you.canEdit === false && !('editors' in anonInfo), '보기(로그인 없음): 버전은 보이고 편집자 목록은 숨김');
const v1 = new Uint8Array(await (await req(D + '/v/1')).arrayBuffer());
ok(v1.length === 1000 && v1[250] === 250, '보기: 버전 1 받기 (암호문, 열쇠는 링크에만)');

const ed = await (await req(D + '/editors', { method: 'PUT', body: JSON.stringify({ editors: ['B@test.kr', 'not-an-email', 'a@test.kr'] }) }, A.token)).json();
ok(JSON.stringify(ed.editors) === '["b@test.kr"]', `A가 영희를 편집자로 지정 (${JSON.stringify(ed.editors)})`);
const bInfo = await (await req(D, {}, B.token)).json();
ok(bInfo.you.canEdit && !bInfo.you.isOwner, 'B 편집 권한 있음(주인 아님)');
const l2 = await req(D + '/lock', { method: 'POST', body: JSON.stringify({ by: 'B' }) }, B.token);
ok(l2.status === 409 && (await l2.json()).lock.by === 'A', 'B 잠금 시도 → A 편집 중');
await req(D + '/lock', { method: 'DELETE', headers: { 'X-Lock-Id': l1.lockId } }, A.token);
const l3 = await (await req(D + '/lock', { method: 'POST', body: JSON.stringify({ by: 'B' }) }, B.token)).json();
ok(!!l3.lockId, 'A가 놓은 뒤 B 잠금');
const p2 = await (await req(D, { method: 'PUT', headers: { 'X-Lock-Id': l3.lockId, 'X-Author': 'B' }, body }, B.token)).json();
ok(p2.n === 2, 'B 버전 2 저장');
ok((await req(D, { method: 'DELETE' }, B.token)).status === 403, 'B(편집자)는 문서 지우기 불가');

const big = await req(D, { method: 'PUT', headers: { 'X-Lock-Id': l3.lockId }, body: new Uint8Array(31 * 1024 * 1024) }, B.token);
ok(big.status === 413, '30MB 넘는 문서 거절');
const mid = new Uint8Array(3.5 * 1024 * 1024); for (let i = 0; i < mid.length; i++) mid[i] = (i * 7) & 255;
const p3 = await (await req(D, { method: 'PUT', headers: { 'X-Lock-Id': l3.lockId }, body: mid }, B.token)).json();
const got3 = new Uint8Array(await (await req(D + '/v/' + p3.n)).arrayBuffer());
ok(got3.length === mid.length && got3.every((v, i) => v === mid[i]), '3.5MB 문서(조각 4개) 저장·받기 일치');

await new Promise((r) => setTimeout(r, 300));
const kinds = events.map((e) => e.type + (e.type === 'version' ? e.n : e.lock ? ':' + e.lock.by : ':풀림')).join(' ');
ok(kinds === 'lock:A version1 lock:풀림 lock:B version2 version3', `실시간 알림 순서: ${kinds}`);

ok((await req(D, { method: 'DELETE' }, A.token)).status === 200, 'A(주인) 문서 지우기');
ok((await req(D)).status === 404 && (await req(D + '/v/1')).status === 404, '지운 뒤 정보·파일 없음');

// ---- 내 문서함 ----
const K = 'k'.repeat(43);
ok((await req('/api/mydocs')).status === 401, '로그인 없이 내 문서함 거절');
ok((await req('/api/mydocs/' + 'x'.repeat(22), { method: 'PUT', body: JSON.stringify({ key: 'short', name: 'a', format: 'hwp', role: 'owner' }) }, A.token)).status === 400, '잘못된 열쇠 형식 거절');
const put1 = await req('/api/mydocs/' + 'a'.repeat(22), { method: 'PUT', body: JSON.stringify({ key: K, name: '과학 보고서.hwp', format: 'hwp', role: 'owner' }) }, A.token);
ok(put1.status === 200, 'A 내 문서함에 넣기');
await req('/api/mydocs/' + 'b'.repeat(22), { method: 'PUT', body: JSON.stringify({ key: K, name: '회의록.docx', format: 'docx', role: 'editor' }) }, A.token);
const listA = await (await req('/api/mydocs', {}, A.token)).json();
ok(listA.enabled === true && listA.docs.length === 2 && listA.docs.some((d) => d.name === '과학 보고서.hwp' && d.key === K), `A 목록: ${listA.docs.map((d) => d.name).join(', ')}`);
const listC = await (await req('/api/mydocs', {}, C.token)).json();
ok(listC.docs.length === 0, '다른 사람(C)에게는 A의 목록이 안 보임');
await req('/api/mydocs/' + 'b'.repeat(22), { method: 'DELETE' }, A.token);
ok((await (await req('/api/mydocs', {}, A.token)).json()).docs.length === 1, 'A 목록에서 빼기');
const off = await (await req('/api/mydocs/settings', { method: 'PUT', body: JSON.stringify({ enabled: false }) }, A.token)).json();
const afterOff = await (await req('/api/mydocs', {}, A.token)).json();
ok(off.enabled === false && afterOff.docs.length === 0, '내 문서함 끄기 → 보관 열쇠 모두 지움');
ok((await req('/api/mydocs/' + 'a'.repeat(22), { method: 'PUT', body: JSON.stringify({ key: K, name: 'x', format: 'hwp', role: 'owner' }) }, A.token)).status === 409, '끈 동안에는 넣기 거절');
await req('/api/mydocs/settings', { method: 'PUT', body: JSON.stringify({ enabled: true }) }, A.token);

// ---- 같은 계정 편집 넘겨받기 ----
const c2 = await (await req('/api/docs', { method: 'POST' }, A.token)).json();
const D2 = '/api/docs/' + c2.id;
await req(D2 + '/editors', { method: 'PUT', body: JSON.stringify({ editors: ['b@test.kr'] }) }, A.token);
const la = await (await req(D2 + '/lock', { method: 'POST', body: JSON.stringify({ by: 'A' }) }, A.token)).json();
const A2 = await login('a@test.kr');
const infoA2 = await (await req(D2, {}, A2.token)).json();
ok(infoA2.lock && infoA2.lock.mine === true, '다른 PC의 같은 계정: "내 잠금"으로 보임');
const infoB2 = await (await req(D2, {}, B.token)).json();
ok(infoB2.lock && !infoB2.lock.mine, '다른 사람(B)에게는 "내 잠금" 표시 없음');
ok((await req(D2 + '/lock', { method: 'POST', body: JSON.stringify({ by: 'B', takeover: true }) }, B.token)).status === 409, '다른 사람(B)은 넘겨받기 불가');
const lt = await (await req(D2 + '/lock', { method: 'POST', body: JSON.stringify({ by: 'A2', takeover: true }) }, A2.token)).json();
ok(!!lt.lockId && lt.lockId !== la.lockId, '같은 계정(다른 PC)은 넘겨받기 가능');
ok((await req(D2 + '/lock', { method: 'POST', body: JSON.stringify({ by: 'A', lockId: la.lockId }) }, A.token)).status === 409, '넘겨준 쪽(PC1)의 잠금 연장은 거절');
await req(D2, { method: 'DELETE' }, A.token);
ws.close();
console.log(fail ? `\n실패 ${fail}개` : '\n모두 통과');
process.exit(fail ? 1 : 0);
