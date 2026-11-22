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

// ---- 아이디 회원가입 ----
const post = (path, body, token) => req(path, { method: 'POST', body: JSON.stringify(body) }, token);
const uid = 'hong' + Date.now().toString(36).slice(-6);
const PW = 'Sejong1443ok';
ok((await post('/api/auth/signup', { username: uid, password: 'short1', agree: true })).status === 400, '짧은 비밀번호 거절');
ok((await post('/api/auth/signup', { username: uid, password: 'abcdefghij', agree: true })).status === 400, '숫자 없는 비밀번호 거절');
ok((await post('/api/auth/signup', { username: uid, password: `${uid}99x`, agree: true })).status === 400, '아이디가 든 비밀번호 거절');
ok((await post('/api/auth/signup', { username: 'Ab', password: PW, agree: true })).status === 400, '잘못된 아이디 형식 거절');
ok((await post('/api/auth/signup', { username: 'admin', password: PW, agree: true })).status === 400, '예약된 아이디 거절');
ok((await post('/api/auth/signup', { username: uid, password: PW })).status === 400, '약관 동의 없이 가입 거절');
const su = await post('/api/auth/signup', { username: uid, password: PW, nick: '홍길동<script>', agree: true });
const S = await su.json();
ok(su.status === 201 && S.token && S.user.email === '@' + uid && /^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/.test(S.recovery), `가입 성공 (@${uid}, 복구 코드 ${S.recovery})`);
ok(S.user.name === '홍길동script', `이름에서 꺾쇠 제거 (${S.user.name})`);
ok((await post('/api/auth/signup', { username: uid.toUpperCase(), password: PW, agree: true })).status === 409, '같은 아이디(대문자) 다시 가입 거절');
const meS = await (await req('/api/me', {}, S.token)).json();
ok(meS.email === '@' + uid && meS.kind === 'id' && meS.agreed === true, '/api/me: 아이디 회원');

ok((await post('/api/auth/login', { username: uid, password: 'Wrong1234' })).status === 401, '틀린 비밀번호 로그인 거절');
const lg = await (await post('/api/auth/login', { username: '@' + uid.toUpperCase(), password: PW })).json();
ok(!!lg.token && lg.user.name === '홍길동script', '아이디(@·대문자 섞임)로 로그인');
ok((await post('/api/auth/login', { username: 'nobody_here', password: PW })).status === 401, '없는 아이디 로그인 거절(같은 안내)');

// 아이디 회원을 편집자로
const c3 = await (await req('/api/docs', { method: 'POST' }, A.token)).json();
const D3 = '/api/docs/' + c3.id;
const e1 = await req(D3 + '/editors', { method: 'PUT', body: JSON.stringify({ editors: ['@nosuchuser9'] }) }, A.token);
ok(e1.status === 400, '없는 @아이디를 편집자로 넣기 거절');
const e2 = await (await req(D3 + '/editors', { method: 'PUT', body: JSON.stringify({ editors: ['@' + uid, 'b@test.kr'] }) }, A.token)).json();
ok(JSON.stringify(e2.editors) === JSON.stringify(['@' + uid, 'b@test.kr']), `@아이디 편집자 지정 (${JSON.stringify(e2.editors)})`);
ok((await (await req(D3, {}, lg.token)).json()).you.canEdit === true, '아이디 회원이 편집 권한 받음');
const forgedId = S.token.split('.'); forgedId[1] = b64u(JSON.stringify({ sub: 'id:x', email: '@' + uid, name: 'x', kind: 'id', tv: 0, exp: Date.now() + 1e9 }));
ok((await req('/api/me', {}, forgedId.join('.'))).status === 401, '아이디 회원 세션 위조 거절');

// 프로필
const pr = await req('/api/account/profile', { method: 'PUT', body: JSON.stringify({ nick: '길동', avatar: 'data:image/png;base64,iVBORw0KGgo=' }) }, S.token);
ok(pr.status === 200 && (await (await req('/api/me', {}, S.token)).json()).name === '길동', '별명·사진 바꾸기');
ok((await req('/api/account/profile', { method: 'PUT', body: JSON.stringify({ avatar: 'javascript:alert(1)' }) }, S.token)).status === 400, '사진 아닌 값 거절');
ok((await req('/api/account/profile', { method: 'PUT', body: JSON.stringify({ avatar: 'data:image/png;base64,' + 'A'.repeat(70000) }) }, S.token)).status === 400, '너무 큰 사진 거절');

// 비밀번호 바꾸기 → 예전 로그인 모두 끊김
const PW2 = 'Hangul2026new';
ok((await req('/api/account/password', { method: 'PUT', body: JSON.stringify({ old: 'Wrong1234', password: PW2 }) }, S.token)).status === 401, '지금 비밀번호 틀리면 변경 거절');
const ch = await (await req('/api/account/password', { method: 'PUT', body: JSON.stringify({ old: PW, password: PW2 }) }, S.token)).json();
ok(!!ch.token, '비밀번호 바꾸기');
ok((await req('/api/me', {}, S.token)).status === 401 && (await req('/api/me', {}, lg.token)).status === 401, '바꾼 뒤 다른 기기의 예전 로그인 끊김');
ok((await req('/api/me', {}, ch.token)).status === 200, '새 로그인 표는 유효');
ok((await post('/api/auth/login', { username: uid, password: PW })).status === 401, '예전 비밀번호로 로그인 불가');

// 복구 코드로 되찾기
ok((await post('/api/auth/recover', { username: uid, code: 'AAAAA-AAAAA-AAAAA-AAAAA-AAAAA', password: 'Recover2026x' })).status === 401, '틀린 복구 코드 거절');
const rc = await (await post('/api/auth/recover', { username: uid, code: S.recovery.toLowerCase().replace(/-/g, ' '), password: 'Recover2026x' })).json();
ok(!!rc.token && rc.recovery && rc.recovery !== S.recovery, '복구 코드(소문자·띄어쓰기)로 되찾기 → 새 복구 코드');
ok((await req('/api/me', {}, ch.token)).status === 401, '되찾은 뒤 예전 로그인 끊김');
ok((await post('/api/auth/recover', { username: uid, code: S.recovery, password: 'Again2026xx' })).status === 401, '쓴 복구 코드는 다시 못 씀');

// 연속 실패 잠금 (위에서 복구 실패 2번 포함 → 처음부터 다시 셈: 성공하면 0)
const uid2 = 'kim' + Date.now().toString(36).slice(-6);
await post('/api/auth/signup', { username: uid2, password: PW, agree: true });
let st5 = [];
for (let i = 0; i < 6; i++) st5.push((await post('/api/auth/login', { username: uid2, password: 'Nope12345' })).status);
const lockRes = await post('/api/auth/login', { username: uid2, password: PW });
ok(st5.slice(0, 4).every((x) => x === 401) && st5[5] === 429 && lockRes.status === 429, `5번 틀리면 잠금, 맞는 비밀번호도 잠시 거절 (${st5.join(',')},${lockRes.status})`);

// 회원 탈퇴
const R = rc.token;
const c4 = await (await req('/api/docs', { method: 'POST' }, R)).json();
const D4 = '/api/docs/' + c4.id;
const l4 = await (await req(D4 + '/lock', { method: 'POST', body: JSON.stringify({ by: 'R' }) }, R)).json();
await req(D4, { method: 'PUT', headers: { 'X-Lock-Id': l4.lockId }, body }, R);
await req('/api/mydocs/' + c4.id, { method: 'PUT', body: JSON.stringify({ key: K, name: '내 글.hwp', format: 'hwp', role: 'owner' }) }, R);
ok((await req(D3 + '/__drop', { method: 'POST', body: JSON.stringify({ user: 'b@test.kr' }) }, A.token)).status === 404, '내부 전용 경로(__drop)는 바깥에서 못 부름');
const l3r = await (await req(D3 + '/lock', { method: 'POST', body: JSON.stringify({ by: 'R' }) }, R)).json();
ok(!!l3r.lockId, '탈퇴할 회원이 A 문서를 편집 중(잠금)');
ok((await req('/api/account', { method: 'DELETE', body: JSON.stringify({ confirm: true, password: 'Wrong1234' }) }, R)).status === 401, '비밀번호 틀리면 탈퇴 거절');
ok((await req('/api/account', { method: 'DELETE', body: JSON.stringify({ password: 'Recover2026x' }) }, R)).status === 400, '확인 없이 탈퇴 거절');
const del = await (await req('/api/account', { method: 'DELETE', body: JSON.stringify({ confirm: true, password: 'Recover2026x' }) }, R)).json();
ok(del.ok && del.removed === 1, `탈퇴 → 내가 주인인 문서 ${del.removed}개 지움`);
ok((await req(D4)).status === 404, '탈퇴한 회원의 문서는 없어짐');
ok((await req('/api/me', {}, R)).status === 401, '탈퇴 뒤 로그인 표 무효');
ok((await post('/api/auth/login', { username: uid, password: 'Recover2026x' })).status === 401, '탈퇴 뒤 로그인 불가');
const infoD3 = await (await req(D3, {}, A.token)).json();
ok(!infoD3.editors.includes('@' + uid) && infoD3.editors.includes('b@test.kr'), `탈퇴 → 남의 문서 편집자 목록에서 빠짐 (${JSON.stringify(infoD3.editors)})`);
ok(infoD3.lock === null, '탈퇴한 회원의 편집 잠금도 풀림');
const re = await post('/api/auth/signup', { username: uid, password: 'Newbie2026zz', nick: '새사람', agree: true });
const NEW = await re.json();
ok(re.status === 201 && !!NEW.token, '탈퇴한 아이디로 새로 가입 가능');
ok((await (await req(D3, {}, NEW.token)).json()).you.canEdit === false, '새로 가입한 사람은 옛 회원의 편집 권한을 못 얻음');
ok((await req('/api/me', {}, R)).status === 401 && (await req('/api/me', {}, lg.token)).status === 401, '옛 회원의 로그인 표는 새 계정으로 되살아나지 않음');
ok((await (await req('/api/me', {}, NEW.token)).json()).name === '새사람', '새 계정은 옛 프로필 없이 새로 시작');
ok((await post('/api/auth/recover', { username: uid, code: rc.recovery, password: 'Steal2026zz' })).status === 401, '옛 회원의 복구 코드로 새 계정 못 가로챔');
ok((await (await req('/api/mydocs', {}, NEW.token)).json()).docs.length === 0, '새 계정의 내 문서함은 비어 있음');
// 편집자에서 뺐다가 다시 넣기 → 기록이 맞게 따라감
const c5 = await (await req('/api/docs', { method: 'POST' }, A.token)).json();
const D5 = '/api/docs/' + c5.id;
await req(D5 + '/editors', { method: 'PUT', body: JSON.stringify({ editors: ['@' + uid] }) }, A.token);
await req(D5 + '/editors', { method: 'PUT', body: JSON.stringify({ editors: [] }) }, A.token);
await req(D5 + '/editors', { method: 'PUT', body: JSON.stringify({ editors: ['@' + uid, 'c@test.kr'] }) }, A.token);
await req('/api/account', { method: 'DELETE', body: JSON.stringify({ confirm: true, password: 'Newbie2026zz' }) }, NEW.token);
ok(JSON.stringify((await (await req(D5, {}, A.token)).json()).editors) === '["c@test.kr"]', '다시 넣은 문서에서도 탈퇴 때 빠짐');
await req(D5, { method: 'DELETE' }, A.token);

// Google 회원 탈퇴
const G = await login('g@test.kr');
const cg = await (await req('/api/docs', { method: 'POST' }, G.token)).json();
ok((await (await req('/api/me', {}, G.token)).json()).agreed === false, 'Google 첫 로그인: 약관 동의 전');
await post('/api/account/agree', {}, G.token);
ok((await (await req('/api/me', {}, G.token)).json()).agreed === true, 'Google: 약관 동의 기록');
const gdel = await (await req('/api/account', { method: 'DELETE', body: JSON.stringify({ confirm: true }) }, G.token)).json();
ok(gdel.ok && gdel.removed === 1 && (await req('/api/docs/' + cg.id)).status === 404, 'Google 회원 탈퇴 → 문서 지움');
ok((await req('/api/me', {}, G.token)).status === 401, 'Google 탈퇴 뒤 예전 로그인 끊김');
const G2 = await login('g@test.kr');
const meG2 = await (await req('/api/me', {}, G2.token)).json();
ok(meG2.email === 'g@test.kr' && meG2.agreed === false, 'Google 다시 로그인 → 새로 시작(약관 다시 동의)');
ok((await (await req('/api/me', {}, A.token)).json()).email === 'a@test.kr', '다른 회원(A)의 로그인은 그대로');
await req(D3, { method: 'DELETE' }, A.token);
console.log(fail ? `\n실패 ${fail}개` : '\n모두 통과');
process.exit(fail ? 1 : 0);
