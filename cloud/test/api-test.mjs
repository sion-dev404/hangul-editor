// 클라우드 서버 API 시험: node cloud/test/api-test.mjs [서버주소]   (wrangler dev가 떠 있어야 함)
const API = process.argv[2] || 'http://127.0.0.1:8787';
const ORIGIN = 'http://localhost:5199';
let fail = 0;
const ok = (c, m) => { console.log(`${c ? '통과' : '실패'}  ${m}`); if (!c) fail++; };
const req = (path, opt = {}) => fetch(API + path, { ...opt, headers: { Origin: ORIGIN, ...(opt.headers || {}) } });

const r0 = await req('/api/docs', { method: 'POST', headers: { Origin: 'https://evil.example' } });
ok(r0.status === 403, '허용 안 된 사이트에서 만들기 거절');

const c = await (await req('/api/docs', { method: 'POST' })).json();
ok(c.id && c.editToken, `문서 만들기 (${c.id})`);
const D = `/api/docs/${c.id}`;

const ws = new WebSocket(API.replace(/^http/, 'ws') + D + '/live', { headers: { Origin: ORIGIN } });
const events = [];
ws.onmessage = (e) => events.push(JSON.parse(e.data));
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
ok(true, '실시간 알림 연결');

const bad = await req(D + '/lock', { method: 'POST', headers: { 'X-Edit-Token': 'wrong' }, body: JSON.stringify({ by: 'A' }) });
ok(bad.status === 403, '틀린 고치기 표식으로 잠금 거절');

const l1 = await (await req(D + '/lock', { method: 'POST', headers: { 'X-Edit-Token': c.editToken }, body: JSON.stringify({ by: 'A' }) })).json();
ok(!!l1.lockId, 'A가 편집 잠금');
const l2 = await req(D + '/lock', { method: 'POST', headers: { 'X-Edit-Token': c.editToken }, body: JSON.stringify({ by: 'B' }) });
const l2j = await l2.json();
ok(l2.status === 409 && l2j.lock.by === 'A', 'B는 잠금 못 함 (A 편집 중으로 안내)');

const body = new Uint8Array(1000).map((_, i) => i % 251);
const pB = await req(D, { method: 'PUT', headers: { 'X-Edit-Token': c.editToken, 'X-Lock-Id': 'nope' }, body });
ok(pB.status === 409, '잠금 없는 사람의 저장 거절');
const p1 = await (await req(D, { method: 'PUT', headers: { 'X-Edit-Token': c.editToken, 'X-Lock-Id': l1.lockId, 'X-Author': 'A' }, body })).json();
ok(p1.n === 1, 'A가 버전 1 저장');
const p2 = await (await req(D, { method: 'PUT', headers: { 'X-Edit-Token': c.editToken, 'X-Lock-Id': l1.lockId, 'X-Author': 'A' }, body: body.slice(0, 500) })).json();
ok(p2.n === 2, 'A가 버전 2 저장');

const info = await (await req(D)).json();
ok(info.versions.length === 2 && info.lock && info.lock.by === 'A', `정보: 버전 ${info.versions.length}개, 잠금 ${info.lock && info.lock.by}`);
const v1 = new Uint8Array(await (await req(D + '/v/1')).arrayBuffer());
ok(v1.length === 1000 && v1[250] === 250, '버전 1 내려받기 (내용 일치)');

await req(D + '/lock', { method: 'DELETE', headers: { 'X-Lock-Id': l1.lockId } });
const info2 = await (await req(D)).json();
ok(info2.lock === null, 'A가 잠금 풀기');
const l3 = await (await req(D + '/lock', { method: 'POST', headers: { 'X-Edit-Token': c.editToken }, body: JSON.stringify({ by: 'B' }) })).json();
ok(!!l3.lockId, '이제 B가 잠금');

await new Promise((r) => setTimeout(r, 300));
const kinds = events.map((e) => e.type + (e.type === 'version' ? e.n : e.lock ? ':' + e.lock.by : ':풀림')).join(' ');
ok(kinds === 'lock:A version1 version2 lock:풀림 lock:B', `실시간 알림 순서: ${kinds}`);

const big = await req(D, { method: 'PUT', headers: { 'X-Edit-Token': c.editToken, 'X-Lock-Id': l3.lockId }, body: new Uint8Array(31 * 1024 * 1024) });
ok(big.status === 413, '30MB 넘는 문서 거절');
const mid = crypto.getRandomValues(new Uint8Array(65536)); const midBody = new Uint8Array(3.5 * 1024 * 1024); for (let i = 0; i < midBody.length; i += 65536) midBody.set(mid.subarray(0, Math.min(65536, midBody.length - i)), i); midBody[midBody.length - 1] = 77;
const p3 = await (await req(D, { method: 'PUT', headers: { 'X-Edit-Token': c.editToken, 'X-Lock-Id': l3.lockId }, body: midBody })).json();
const got3 = new Uint8Array(await (await req(D + '/v/' + p3.n)).arrayBuffer());
ok(got3.length === midBody.length && got3[got3.length - 1] === 77 && got3[1048577] === midBody[1048577], `3.5MB 문서(조각 4개) 저장·받기 일치 (버전 ${p3.n})`);

const del = await req(D, { method: 'DELETE', headers: { 'X-Edit-Token': c.editToken } });
ok(del.status === 200, '문서 지우기');
ok((await req(D)).status === 404, '지운 뒤 정보 없음');
ok((await req(D + '/v/1')).status === 404, '지운 뒤 파일 없음');
ws.close();
console.log(fail ? `\n실패 ${fail}개` : '\n모두 통과');
process.exit(fail ? 1 : 0);
