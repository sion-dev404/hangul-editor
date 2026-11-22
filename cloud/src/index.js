// 한글 편집기 클라우드 서버
// - 문서 내용·파일 이름·작성자 이름은 모두 편집기(내 PC)에서 암호화되어 온다. 서버는 열쇠가 없어 읽을 수 없다.
// - 로그인: Google(OpenID Connect) 또는 아이디+비밀번호 회원(accounts.js, 비밀번호는 해시만 보관).
//   계정 표시(principal) = Google 이메일 또는 "@아이디". 문서 주인·편집자·내 문서함은 모두 이 표시로 구분한다.
//   로그인 창 → Google → /auth/google/callback → 1회용 코드(2분, PKCE로 요청한 편집기에만 묶임) → /api/auth/exchange → 세션 표(서명, 30일)
// - 권한: 문서 만들기·저장·잠금·되돌리기 = 로그인 + (주인 또는 주인이 지정한 이메일). 지우기·편집자 지정 = 주인만. 보기 = 링크(열쇠)만 있으면.
// - 문서마다 Durable Object(DocRoom) 하나: 권한, 편집 잠금, 버전 목록, 실시간 알림(WebSocket), 버전 파일(1MB 조각)
//
// 비밀값(wrangler secret put): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET
// 로컬 시험(.dev.vars): DEV_LOGIN=1 이면 /auth/dev/start?email=… 로 Google 없이 로그인 (배포본에는 없음)
//
// API
//   GET    /auth/google/start?challenge&ret   로그인 시작 (ret = 편집기 주소, 허용 목록만)
//   GET    /auth/google/callback               Google이 돌려보냄
//   POST   /api/auth/exchange {code, verifier} → { token, user:{email,name} }
//   POST   /api/auth/signup {username,password,nick,agree} → { token, user, recovery }
//   POST   /api/auth/login  {username,password}  → { token, user }
//   POST   /api/auth/recover {username,code,password} → { token, user, recovery }
//   GET    /api/me                             → { email, name, kind, avatar, agreed }
//   PUT    /api/account/profile {nick?,avatar?}   POST /api/account/agree
//   PUT    /api/account/password {old,password} → { token }   POST /api/account/recovery {password} → { recovery }
//   DELETE /api/account {password?,confirm}    회원 탈퇴 (내가 주인인 문서와 내 문서함을 지움)
//   POST   /api/docs                    새 문서 (로그인) → { id }
//   GET    /api/docs/:id                정보 → { versions, lock, created, you:{canEdit,isOwner}, editors? }
//   GET    /api/docs/:id/v/:n           버전 n의 암호화된 파일
//   PUT    /api/docs/:id                새 버전 (편집 권한 + 잠금, X-Lock-Id, X-Author)
//   POST   /api/docs/:id/lock           편집 잠금 잡기·연장 {by, lockId?}
//   DELETE /api/docs/:id/lock           잠금 풀기 (X-Lock-Id)
//   PUT    /api/docs/:id/editors        고칠 수 있는 사람 {editors:[email]} (주인)
//   DELETE /api/docs/:id                문서 지우기 (주인)
//   GET    /api/docs/:id/live           WebSocket: {type:'version'|'lock'|'deleted', ...}

import { homePage, privacyPage, termsPage } from './pages.js';
import { CLOUD_LOGO_SVG } from './logo.js';
import { Account, ID_PRINCIPAL_RE, checkPassword, checkUsername, cleanNick, AVATAR_MAX } from './accounts.js';
export { Account };

const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const AUTHOR_MAX = 600;
const SESSION_DAYS = 30;
const EMAIL_RE = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,255}\.[A-Za-z]{2,}$/;
const enc = new TextEncoder();

/* ---------- 도우미 ---------- */
const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const rand = (n) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const sha256b64u = async (s) => b64u(await crypto.subtle.digest('SHA-256', enc.encode(s)));
function sameStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function hmacKey(env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET이 설정되지 않았습니다');
  return crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
// 서명한 작은 표: <kind>.<payload>.<sig> — 종류가 다른 표를 서로 바꿔 쓰지 못하게 kind도 서명에 넣는다
async function sign(env, kind, data) {
  const p = b64u(enc.encode(JSON.stringify(data)));
  const sig = b64u(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(`${kind}.${p}`)));
  return `${kind}.${p}.${sig}`;
}
async function verify(env, kind, token) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const [k, p, sig] = token.split('.');
  if (k !== kind || !p || !sig) return null;
  let ok = false;
  try { ok = await crypto.subtle.verify('HMAC', await hmacKey(env), unb64u(sig), enc.encode(`${k}.${p}`)); } catch { return null; }
  if (!ok) return null;
  let data; try { data = JSON.parse(new TextDecoder().decode(unb64u(p))); } catch { return null; }
  if (!data.exp || data.exp < Date.now()) return null;
  return data;
}
const allowedOrigins = (env) => env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
function cors(req, env) {
  const origin = req.headers.get('Origin') || '';
  return allowedOrigins(env).includes(origin) ? {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Lock-Id, X-Author',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  } : { Vary: 'Origin' };
}
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
const SEC_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
};
const page = (title, body, script = '') => new Response(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="font:15px/1.6 'Malgun Gothic',sans-serif;display:grid;place-items:center;min-height:90vh;color:#1d2430;background:#f3f5f8;margin:0">
<div style="background:#fff;border-radius:14px;padding:28px 34px;box-shadow:0 8px 30px rgba(20,40,80,.12);max-width:420px;text-align:center">${body}</div>${script}</body></html>`, { headers: SEC_HEADERS });
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function sessionOf(req, env) {
  const a = req.headers.get('Authorization') || '';
  if (!a.startsWith('Bearer ')) return null;
  const ses = await verify(env, 'ses', a.slice(7));
  if (!ses) return null;
  // 비밀번호 변경·탈퇴로 끊긴 로그인인지 계정에 묻는다
  const { data } = await acctCall(env, ses.email, '/check', { tv: ses.tv || 0 });
  return data.ok ? ses : null;
}
const acct = (env, principal) => env.ACCOUNT.get(env.ACCOUNT.idFromName(principal));
async function acctCall(env, principal, path, body, method = 'POST') {
  const res = await acct(env, principal).fetch(`https://acct${path}`, method === 'GET' ? {} : { method, body: JSON.stringify(body || {}) });
  return { res, data: await res.clone().json().catch(() => ({})) };
}
const newSession = async (env, user, tv) => sign(env, 'ses', { ...user, tv, exp: Date.now() + SESSION_DAYS * 86400 * 1000 });
const isPrincipal = (p) => EMAIL_RE.test(p) || ID_PRINCIPAL_RE.test(p);
const clientIp = (req) => req.headers.get('CF-Connecting-IP') || 'local';
async function ipLimit(env, req, what, max) {
  const lim = env.LIMIT.get(env.LIMIT.idFromName(`ip:${what}:${clientIp(req)}`));
  return (await (await lim.fetch('https://limit/take', { method: 'POST', body: String(max) })).json()).ok;
}

/* ---------- 로그인 ---------- */
async function authStart(url, env) {
  const challenge = url.searchParams.get('challenge') || '';
  const ret = url.searchParams.get('ret') || '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge) || !allowedOrigins(env).includes(ret)) return page('로그인', '<b>잘못된 로그인 요청입니다.</b>');
  const nonce = rand(16);
  const state = await sign(env, 'st', { c: challenge, ret, n: nonce, exp: Date.now() + 10 * 60 * 1000 });
  if (url.pathname === '/auth/dev/start') {
    if (env.DEV_LOGIN !== '1') return page('로그인', '<b>사용할 수 없습니다.</b>');
    const email = (url.searchParams.get('email') || '').toLowerCase();
    if (!EMAIL_RE.test(email)) return page('로그인', '<b>이메일이 올바르지 않습니다.</b>');
    return finishLogin(env, { sub: `dev:${email}`, email, name: url.searchParams.get('name') || email.split('@')[0] }, { c: challenge, ret });
  }
  if (!env.GOOGLE_CLIENT_ID) return page('로그인', '<b>아직 로그인을 준비하고 있습니다.</b>');
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${url.origin}/auth/google/callback`, response_type: 'code',
    scope: 'openid email profile', state, nonce, prompt: 'select_account',
  });
  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`, 302);
}

async function authCallback(url, env) {
  const st = await verify(env, 'st', url.searchParams.get('state'));
  if (!st) return page('로그인', '<b>로그인 시간이 지났거나 잘못된 요청입니다.</b><br>편집기에서 다시 로그인해 주세요.');
  if (url.searchParams.get('error')) return page('로그인', '<b>로그인을 취소했습니다.</b><br>이 창을 닫아 주세요.');
  const code = url.searchParams.get('code');
  if (!code) return page('로그인', '<b>잘못된 요청입니다.</b>');
  // Google에 직접(TLS + 클라이언트 비밀) 물어 받은 id_token이므로 내용은 Google이 보증한다
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: `${url.origin}/auth/google/callback`, grant_type: 'authorization_code' }),
  });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.id_token) return page('로그인', '<b>Google 로그인에 실패했습니다.</b>');
  let claims;
  try { claims = JSON.parse(new TextDecoder().decode(unb64u(tok.id_token.split('.')[1]))); } catch { return page('로그인', '<b>Google 로그인에 실패했습니다.</b>'); }
  const now = Date.now() / 1000;
  if (claims.aud !== env.GOOGLE_CLIENT_ID || !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)
    || !(claims.exp > now) || claims.nonce !== st.n || claims.email_verified !== true || !claims.email) {
    return page('로그인', '<b>확인되지 않은 Google 계정입니다.</b>');
  }
  return finishLogin(env, { sub: `g:${claims.sub}`, email: String(claims.email).toLowerCase(), name: String(claims.name || claims.email).slice(0, 40) }, st);
}

async function finishLogin(env, user, st) {
  const code = await sign(env, 'lc', { ...user, c: st.c, exp: Date.now() + 2 * 60 * 1000 });
  const desktop = /^http:\/\/127\.0\.0\.1:\d+$/.test(st.ret);
  if (desktop) {
    // 설치형: 이 PC의 편집기 내장 서버로 1회용 코드를 넘긴다 (코드만으로는 쓸 수 없고, 요청한 편집기만 아는 비밀값이 필요)
    return Response.redirect(`${st.ret}/__auth?code=${encodeURIComponent(code)}`, 302);
  }
  // 웹판: 로그인 창을 연 편집기 창에만 코드를 건넨다
  return page('로그인 완료', `<b>${esc(user.email)}</b>(으)로 로그인했습니다.<br>잠시 뒤 이 창이 닫힙니다.`,
    `<script>try{window.opener&&window.opener.postMessage({type:'hangul-auth',code:${JSON.stringify(code)}},${JSON.stringify(st.ret)});}catch(e){}setTimeout(function(){window.close()},800)</script>`);
}

async function authExchange(req, env) {
  const { code, verifier } = await req.json().catch(() => ({}));
  const lc = await verify(env, 'lc', code);
  if (!lc || typeof verifier !== 'string' || verifier.length < 43 || verifier.length > 128) return json({ error: 'bad code' }, 400);
  if (!sameStr(await sha256b64u(verifier), lc.c)) return json({ error: 'bad verifier' }, 400);
  const user = { sub: lc.sub, email: lc.email, name: lc.name, kind: 'google' };
  const { data } = await acctCall(env, user.email, '/tv');
  const token = await newSession(env, user, data.tv || 0);
  return json({ token, user: { email: user.email, name: user.name, kind: 'google' } });
}

/* ---------- 아이디 회원 ---------- */
const idUser = (username, nick) => ({ sub: `id:${username}`, email: `@${username}`, name: nick || username, kind: 'id' });
const tooMany = () => json({ error: 'limit', message: '요청이 너무 많습니다. 잠시 뒤에 다시 해 주세요' }, 429);
async function signup(req, env) {
  const b = await req.json().catch(() => ({}));
  const username = String(b.username || '').trim().toLowerCase();
  const bad = checkUsername(username) || checkPassword(b.password, username);
  if (bad) return json({ error: 'bad', message: bad }, 400);
  if (b.agree !== true) return json({ error: 'agree', message: '이용약관과 개인정보처리방침에 동의해 주세요' }, 400);
  if (!(await ipLimit(env, req, 'signup', Number(env.SIGNUPS_PER_DAY) || 10))) return tooMany();
  const nick = cleanNick(b.nick) || username;
  const { res, data } = await acctCall(env, `@${username}`, '/create', { username, password: b.password, nick });
  if (!res.ok) return json(data, res.status);
  const user = idUser(username, nick);
  return json({ token: await newSession(env, user, data.tv), user: { email: user.email, name: user.name, kind: 'id' }, recovery: data.recovery }, 201);
}
async function passwordLogin(req, env, recover) {
  const b = await req.json().catch(() => ({}));
  const username = String(b.username || '').trim().toLowerCase().replace(/^@/, '');
  const badMsg = recover ? '아이디 또는 복구 코드가 맞지 않습니다' : '아이디 또는 비밀번호가 맞지 않습니다';
  if (!(await ipLimit(env, req, 'login', 200))) return tooMany();
  if (checkUsername(username)) return json({ error: 'bad', message: badMsg }, 401);
  if (recover) { const bad = checkPassword(b.password, username); if (bad) return json({ error: 'weak', message: bad }, 400); }
  const { res, data } = await acctCall(env, `@${username}`, recover ? '/recover' : '/login', recover ? { code: b.code, password: b.password } : { password: b.password });
  if (!res.ok) return json(data, res.status);
  const user = idUser(username, data.nick);
  return json({ token: await newSession(env, user, data.tv), user: { email: user.email, name: user.name, kind: 'id' }, ...(recover ? { recovery: data.recovery } : {}) });
}
async function ownedInVault(env, p) {
  const ids = [];
  try {
    const vault = env.VAULT.get(env.VAULT.idFromName(p));
    const vk = await vaultKey(env, p);
    const st = await (await vault.fetch('https://vault/list')).json();
    for (const e of st.docs) {
      try {
        const raw = unb64u(e.enc);
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12), additionalData: enc.encode(e.id) }, vk, raw.subarray(12));
        if (JSON.parse(new TextDecoder().decode(plain)).role === 'owner') ids.push(e.id);
      } catch { /* 망가진 칸 */ }
    }
  } catch { /* 보관함 없음 */ }
  return ids;
}
async function account(req, url, env, ses) {
  const p = ses.email;
  if (url.pathname === '/api/account/profile' && req.method === 'PUT') {
    const b = await req.json().catch(() => ({}));
    const out = {};
    if ('nick' in b) { out.nick = cleanNick(b.nick); if (!out.nick) return json({ error: 'bad', message: '이름을 넣어 주세요' }, 400); }
    if ('avatar' in b) { if (b.avatar && String(b.avatar).length > AVATAR_MAX) return json({ error: 'bad avatar', message: '사진이 너무 큽니다' }, 400); out.avatar = b.avatar || null; }
    const { res, data } = await acctCall(env, p, '/profile', out, 'PUT');
    return json(data, res.status);
  }
  if (url.pathname === '/api/account/agree' && req.method === 'POST') return json((await acctCall(env, p, '/agree')).data);
  if (url.pathname === '/api/account/password' && req.method === 'PUT') {
    if (ses.kind !== 'id') return json({ error: 'bad', message: 'Google 계정의 비밀번호는 Google에서 바꿉니다' }, 400);
    const b = await req.json().catch(() => ({}));
    const bad = checkPassword(b.password, p.slice(1));
    if (bad) return json({ error: 'weak', message: bad }, 400);
    const { res, data } = await acctCall(env, p, '/passwd', { old: b.old, password: b.password });
    if (!res.ok) return json(data, res.status);
    return json({ token: await newSession(env, { sub: ses.sub, email: ses.email, name: ses.name, kind: 'id' }, data.tv) });
  }
  if (url.pathname === '/api/account/recovery' && req.method === 'POST') {
    if (ses.kind !== 'id') return json({ error: 'bad' }, 400);
    const b = await req.json().catch(() => ({}));
    const { res, data } = await acctCall(env, p, '/newcode', { password: b.password });
    return json(data, res.status);
  }
  if (url.pathname === '/api/account' && req.method === 'DELETE') {
    const b = await req.json().catch(() => ({}));
    if (b.confirm !== true) return json({ error: 'confirm', message: '탈퇴를 확인해 주세요' }, 400);
    const ids = new Set(await ownedInVault(env, p)); // 계정을 지우기 전에 모은다
    const { res, data } = await acctCall(env, p, '/delete', { password: b.password });
    if (!res.ok) return json(data, res.status);
    for (const id of data.owned || []) ids.add(id);
    let removed = 0;
    for (const id of ids) {
      if (!ID_RE.test(id)) continue;
      const r = await env.ROOM.get(env.ROOM.idFromName(id)).fetch('https://room/', { method: 'DELETE', headers: { 'X-User': p } });
      if (r.ok) removed++;
    }
    // 남의 문서 편집자 목록에서 이 아이디를 빼고 나서야 아이디를 풀어 준다 (새로 가입한 사람이 옛 권한을 얻지 못하게)
    let dropped = true;
    for (const id of data.shared || []) {
      if (!ID_RE.test(id)) continue;
      const r = await env.ROOM.get(env.ROOM.idFromName(id)).fetch('https://room/__drop', { method: 'POST', body: JSON.stringify({ user: p }) });
      if (!r.ok && r.status !== 404) dropped = false;
    }
    if (dropped) await acctCall(env, p, '/free');
    // 내 문서함 비우기 (끄면 모두 지워지고, 다시 켜 둔다)
    const vault = env.VAULT.get(env.VAULT.idFromName(p));
    await vault.fetch('https://vault/settings', { method: 'PUT', body: JSON.stringify({ enabled: false }) });
    await vault.fetch('https://vault/settings', { method: 'PUT', body: JSON.stringify({ enabled: true }) });
    return json({ ok: true, removed });
  }
  return json({ error: 'not found' }, 404);
}

/* ---------- 내 문서함 (한컴독스처럼 어느 PC에서나) ----------
 * 문서 열쇠·이름을 서버 비밀키(VAULT_SECRET, 로그인 서명 키와 별도)로 다시 잠가 계정별 보관함(Vault)에 둔다.
 * - 잠금 열쇠 = HKDF(VAULT_SECRET, 계정 이메일) → 계정마다 다름. 문서 id를 함께 묶어(AAD) 다른 칸에 옮겨 붙일 수 없다.
 * - 저장소가 유출돼도 VAULT_SECRET 없이는 읽을 수 없다. (서버 자체가 뚫리면 열릴 수 있음 — 개인정보처리방침에 밝힘)
 * - 이용자가 "내 문서함 끄기"를 하면 보관된 열쇠를 모두 지우고 다시 넣지 않는다.
 */
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const FORMATS = ['hwp', 'hwpx', 'docx'];
const ROLES = ['owner', 'editor', 'viewer'];
const MAX_MYDOCS = 2000;
async function vaultKey(env, email) {
  if (!env.VAULT_SECRET || env.VAULT_SECRET.length < 32) throw new Error('VAULT_SECRET이 설정되지 않았습니다');
  const base = await crypto.subtle.importKey('raw', enc.encode(env.VAULT_SECRET), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(`vault:${email}`), info: enc.encode('hangul-editor mydocs v1') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function myDocs(req, url, env, ses) {
  const vault = env.VAULT.get(env.VAULT.idFromName(ses.email));
  const vk = await vaultKey(env, ses.email);
  const id = url.pathname.split('/')[3] || '';
  if (url.pathname === '/api/mydocs' && req.method === 'GET') {
    const st = await (await vault.fetch('https://vault/list')).json();
    const docs = [];
    for (const e of st.docs) {
      try {
        const raw = unb64u(e.enc);
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12), additionalData: enc.encode(e.id) }, vk, raw.subarray(12));
        docs.push({ id: e.id, ...JSON.parse(new TextDecoder().decode(plain)), added: e.added, opened: e.opened });
      } catch { /* 망가진 칸은 건너뛴다 */ }
    }
    docs.sort((a, b) => b.opened - a.opened);
    return json({ enabled: st.enabled, docs });
  }
  if (url.pathname === '/api/mydocs/settings' && req.method === 'PUT') {
    const body = await req.json().catch(() => ({}));
    return vault.fetch('https://vault/settings', { method: 'PUT', body: JSON.stringify({ enabled: body.enabled !== false }) });
  }
  if (!ID_RE.test(id)) return json({ error: 'bad id' }, 400);
  if (req.method === 'PUT') {
    const body = await req.json().catch(() => ({}));
    if (!KEY_RE.test(body.key || '') || !FORMATS.includes(body.format) || !ROLES.includes(body.role)) return json({ error: 'bad entry' }, 400);
    const name = String(body.name || '').slice(0, 200);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(id) }, vk,
      enc.encode(JSON.stringify({ key: body.key, name, format: body.format, role: body.role }))));
    const all = new Uint8Array(12 + ct.length); all.set(iv); all.set(ct, 12);
    return vault.fetch('https://vault/put', { method: 'PUT', body: JSON.stringify({ id, enc: b64u(all) }) });
  }
  if (req.method === 'DELETE') return vault.fetch('https://vault/del', { method: 'DELETE', body: JSON.stringify({ id }) });
  return json({ error: 'not found' }, 404);
}

export class Vault {
  constructor(state) { this.state = state; }
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const enabled = (await this.state.storage.get('enabled')) !== false;
    if (path === '/list') {
      const map = await this.state.storage.list({ prefix: 'd:' });
      return json({ enabled, docs: [...map.values()] });
    }
    if (path === '/settings') {
      const { enabled: on } = await req.json();
      await this.state.storage.put('enabled', on);
      if (!on) { const map = await this.state.storage.list({ prefix: 'd:' }); await this.state.storage.delete([...map.keys()]); }
      return json({ enabled: on });
    }
    if (path === '/put') {
      if (!enabled) return json({ error: 'disabled', message: '내 문서함이 꺼져 있습니다' }, 409);
      const { id, enc: e } = await req.json();
      const prev = await this.state.storage.get(`d:${id}`);
      if (!prev) {
        const count = (await this.state.storage.list({ prefix: 'd:', limit: MAX_MYDOCS + 1 })).size;
        if (count >= MAX_MYDOCS) return json({ error: 'full', message: '내 문서함이 가득 찼습니다' }, 409);
      }
      const now = Date.now();
      await this.state.storage.put(`d:${id}`, { id, enc: e, added: prev ? prev.added : now, opened: now });
      return json({ ok: true });
    }
    if (path === '/del') {
      const { id } = await req.json();
      await this.state.storage.delete(`d:${id}`);
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  }
}

/* ---------- 진입점 ---------- */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const h = cors(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    try {
      if (url.pathname === '/auth/google/start' || url.pathname === '/auth/dev/start') return await authStart(url, env);
      if (url.pathname === '/auth/google/callback') return await authCallback(url, env);
      if (url.pathname === '/' || url.pathname === '/index.html') return new Response(homePage(), { headers: { ...SEC_HEADERS, 'Cache-Control': 'public, max-age=600' } });
      if (url.pathname === '/logo.svg' || url.pathname === '/favicon.ico') return new Response(CLOUD_LOGO_SVG, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
      if (url.pathname === '/terms') return new Response(termsPage(), { headers: { ...SEC_HEADERS, 'Cache-Control': 'public, max-age=600' } });
      if (url.pathname === '/privacy') return new Response(privacyPage(), { headers: { ...SEC_HEADERS, 'Cache-Control': 'public, max-age=600' } });
      if (!url.pathname.startsWith('/api/')) return new Response('찾는 페이지가 없습니다', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      // 허용된 편집기 화면에서만 쓴다
      if (!('Access-Control-Allow-Origin' in h)) return json({ error: 'origin' }, 403, h);

      if (url.pathname === '/api/auth/exchange' && req.method === 'POST') return withCors(await authExchange(req, env), h);
      if (url.pathname === '/api/auth/signup' && req.method === 'POST') return withCors(await signup(req, env), h);
      if (url.pathname === '/api/auth/login' && req.method === 'POST') return withCors(await passwordLogin(req, env, false), h);
      if (url.pathname === '/api/auth/recover' && req.method === 'POST') return withCors(await passwordLogin(req, env, true), h);
      const ses = await sessionOf(req, env);
      if (url.pathname === '/api/me') {
        if (!ses) return json({ error: 'login' }, 401, h);
        const { data } = await acctCall(env, ses.email, '/profile', null, 'GET');
        const kind = ses.kind || 'google';
        return json({ email: ses.email, name: data.nick || ses.name, kind, avatar: data.avatar || '', agreed: kind === 'id' || !!data.terms }, 200, h);
      }
      if (url.pathname === '/api/account' || url.pathname.startsWith('/api/account/')) {
        if (!ses) return json({ error: 'login', message: '로그인해 주세요' }, 401, h);
        return withCors(await account(req, url, env, ses), h);
      }
      if (url.pathname === '/api/mydocs' || url.pathname.startsWith('/api/mydocs/')) {
        if (!ses) return json({ error: 'login', message: '로그인해 주세요' }, 401, h);
        return withCors(await myDocs(req, url, env, ses), h);
      }

      const parts = url.pathname.split('/').filter(Boolean); // api, docs, :id, ...
      if (parts[1] !== 'docs') return json({ error: 'not found' }, 404, h);

      if (parts.length === 2 && req.method === 'POST') {
        if (!ses) return json({ error: 'login', message: '클라우드에 올리려면 로그인해 주세요' }, 401, h);
        const lim = env.LIMIT.get(env.LIMIT.idFromName(ses.sub));
        const ok = await (await lim.fetch('https://limit/take', { method: 'POST', body: env.CREATES_PER_DAY })).json();
        if (!ok.ok) return json({ error: 'limit', message: '오늘 만들 수 있는 문서 수를 넘었습니다' }, 429, h);
        const id = rand(16);
        const room = env.ROOM.get(env.ROOM.idFromName(id));
        await room.fetch('https://room/init', { method: 'POST', body: JSON.stringify({ id, owner: ses.email }) });
        await acctCall(env, ses.email, '/own', { id }); // 탈퇴할 때 함께 지우려고 기록
        return json({ id }, 201, h);
      }

      const id = parts[2];
      if (!ID_RE.test(id || '')) return json({ error: 'bad id' }, 400, h);
      const room = env.ROOM.get(env.ROOM.idFromName(id));
      if (parts[3] === 'live') {
        if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'websocket only' }, 426, h);
        return room.fetch(new Request('https://room/live', req));
      }
      // 방에는 확인된 로그인 이메일만 넘긴다 (편집기가 보낸 같은 이름의 머리글은 버린다)
      const headers = new Headers(req.headers);
      headers.delete('X-User');
      if (ses) headers.set('X-User', ses.email);
      // 내부 전용 경로(__drop 등)는 바깥에서 부를 수 없다
      if ((parts[3] || '').startsWith('__')) return json({ error: 'not found' }, 404, h);
      let fwdBody = req.body;
      let before = null; // 편집자 목록을 바꾸기 전 목록 (아이디 회원 기록을 맞추려고)
      if (parts[3] === 'editors' && req.method === 'PUT') {
        if (ses) before = (await (await room.fetch('https://room/', { headers: { 'X-User': ses.email } })).json().catch(() => ({}))).editors || null;
        // 편집자로 넣는 "@아이디"는 실제로 있는 회원이어야 한다 (오타로 엉뚱한 사람에게 권한이 가지 않게)
        const b = await req.json().catch(() => ({}));
        const list = Array.isArray(b.editors) ? b.editors.map((e) => String(e).trim().toLowerCase()) : [];
        for (const e of list) {
          if (ID_PRINCIPAL_RE.test(e) && !(await acctCall(env, e, '/exists')).data.exists) return json({ error: 'no user', message: `${e} 아이디의 회원이 없습니다` }, 400, h);
        }
        fwdBody = JSON.stringify({ editors: list });
      }
      const fwd = new Request(`https://room/${parts.slice(3).join('/')}`, { method: req.method, headers, body: fwdBody });
      const out = await room.fetch(fwd);
      if (ses && req.method === 'DELETE' && parts.length === 3 && out.ok) await acctCall(env, ses.email, '/unown', { id });
      if (before && out.ok) {
        // 아이디 회원 계정에 "이 문서의 편집자"인지 적어 둔다 → 탈퇴할 때 이 문서에서 빠진다
        const after = (await out.clone().json().catch(() => ({}))).editors || [];
        for (const e of after) if (ID_PRINCIPAL_RE.test(e) && !before.includes(e)) await acctCall(env, e, '/shared', { id });
        for (const e of before) if (ID_PRINCIPAL_RE.test(e) && !after.includes(e)) await acctCall(env, e, '/unshared', { id });
      }
      return withCors(out, h);
    } catch (e) {
      return json({ error: 'server', message: String((e && e.message) || e) }, 500, h);
    }
  },
};
function withCors(res, h) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(h)) out.headers.set(k, v);
  return out;
}

/* ---------- 문서 방 ---------- */
const CHUNK = 1024 * 1024; // 저장소 값 하나의 한도(2MB)보다 작게

export class DocRoom {
  constructor(state, env) { this.state = state; this.env = env; }

  async putBlob(n, buf) {
    const u8 = new Uint8Array(buf);
    const count = Math.ceil(u8.length / CHUNK);
    const keys = [];
    for (let i = 0; i < count; i++) keys.push(`c:${n}:${i}`);
    for (let i = 0; i < count; i += 100) {
      const part = {};
      for (let j = i; j < Math.min(count, i + 100); j++) part[keys[j]] = u8.slice(j * CHUNK, (j + 1) * CHUNK);
      await this.state.storage.put(part);
    }
    return count;
  }
  async getBlob(n, count, size) {
    const out = new Uint8Array(size);
    let off = 0;
    for (let i = 0; i < count; i += 100) {
      const keys = []; for (let j = i; j < Math.min(count, i + 100); j++) keys.push(`c:${n}:${j}`);
      const got = await this.state.storage.get(keys);
      for (const k of keys) { const c = got.get(k); if (!c) return null; out.set(c, off); off += c.length; }
    }
    return out;
  }
  async delBlob(n, count) {
    const keys = []; for (let i = 0; i < count; i++) keys.push(`c:${n}:${i}`);
    for (let i = 0; i < keys.length; i += 100) await this.state.storage.delete(keys.slice(i, i + 100));
  }

  async meta() { return (await this.state.storage.get('meta')) || null; }
  async activeLock() {
    const l = await this.state.storage.get('lock');
    return l && l.until > Date.now() ? l : null;
  }
  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) { try { ws.send(s); } catch { /* 끊긴 연결 */ } }
  }

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/+/, '');
    const now = Date.now();

    if (path === 'init' && req.method === 'POST') {
      const { id, owner } = await req.json();
      if (await this.meta()) return json({ error: 'exists' }, 409);
      await this.state.storage.put('meta', { id, owner, editors: [], created: now, versions: [], next: 1 });
      return json({ ok: true }, 201);
    }

    const meta = await this.meta();
    if (!meta) return json({ error: 'not found' }, 404);

    if (path === 'live') {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const user = req.headers.get('X-User') || null;
    const isOwner = !!user && user === meta.owner;
    const canEdit = isOwner || (!!user && meta.editors.includes(user));
    const needEdit = () => (user
      ? json({ error: 'forbidden', message: '이 문서를 고칠 권한이 없습니다. 문서 주인에게 요청해 주세요' }, 403)
      : json({ error: 'login', message: '고치려면 로그인해 주세요' }, 401));
    const lockInfo = (l) => (l ? { by: l.by, until: l.until, ...(user && l.user === user ? { mine: true } : {}) } : null);

    if (path.startsWith('v/') && req.method === 'GET') {
      const n = Number(path.slice(2));
      const v = meta.versions.find((x) => x.n === n);
      if (!v) return json({ error: 'not found' }, 404);
      const data = await this.getBlob(n, v.chunks, v.size);
      if (!data) return json({ error: 'not found' }, 404);
      return new Response(data, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=31536000, immutable' } });
    }

    if (path === '' && req.method === 'GET') {
      return json({
        versions: meta.versions.map(({ n, at, size, by }) => ({ n, at, size, by })), lock: lockInfo(await this.activeLock()), created: meta.created,
        you: { canEdit, isOwner, login: !!user }, ...(isOwner ? { editors: meta.editors } : {}),
      });
    }

    if (path === 'lock' && req.method === 'POST') {
      if (!canEdit) return needEdit();
      const body = await req.json().catch(() => ({}));
      const by = String(body.by || '').slice(0, AUTHOR_MAX);
      const cur = await this.activeLock();
      // 같은 계정이 다른 PC·창에서 잡고 있으면 넘겨받을 수 있다 (남의 잠금은 못 가져감)
      const takeover = !!(cur && cur.lockId !== body.lockId && body.takeover === true && cur.user && cur.user === user);
      if (cur && cur.lockId !== body.lockId && !takeover) return json({ error: 'locked', lock: lockInfo(cur) }, 409);
      const lock = { lockId: cur && !takeover ? cur.lockId : rand(16), by, user, until: now + Number(this.env.LOCK_SECONDS) * 1000 };
      await this.state.storage.put('lock', lock);
      if (!cur || takeover) this.broadcast({ type: 'lock', lock: { by: lock.by, until: lock.until } });
      return json({ lockId: lock.lockId, until: lock.until });
    }

    if (path === 'lock' && req.method === 'DELETE') {
      const cur = await this.activeLock();
      if (cur && cur.lockId === req.headers.get('X-Lock-Id')) {
        await this.state.storage.delete('lock');
        this.broadcast({ type: 'lock', lock: null });
      }
      return json({ ok: true });
    }

    if (path === '__drop' && req.method === 'POST') {
      // 탈퇴한 회원을 편집자 목록에서 빼고, 그 회원의 편집 잠금도 푼다 (서버 안에서만 부름)
      const { user: gone } = await req.json().catch(() => ({}));
      meta.editors = meta.editors.filter((e) => e !== gone);
      await this.state.storage.put('meta', meta);
      const l = await this.activeLock();
      if (l && l.user === gone) { await this.state.storage.delete('lock'); this.broadcast({ type: 'lock', lock: null }); }
      return json({ ok: true });
    }

    if (path === 'editors' && req.method === 'PUT') {
      if (!isOwner) return user ? json({ error: 'forbidden', message: '문서 주인만 바꿀 수 있습니다' }, 403) : json({ error: 'login' }, 401);
      const body = await req.json().catch(() => ({}));
      const list = [...new Set((Array.isArray(body.editors) ? body.editors : []).map((e) => String(e).trim().toLowerCase()))]
        .filter((e) => isPrincipal(e) && e !== meta.owner).slice(0, 50);
      meta.editors = list;
      await this.state.storage.put('meta', meta);
      return json({ editors: list });
    }

    if (path === '' && req.method === 'PUT') {
      if (!canEdit) return needEdit();
      const cur = await this.activeLock();
      if (cur && cur.lockId !== req.headers.get('X-Lock-Id')) return json({ error: 'locked', lock: lockInfo(cur) }, 409);
      const max = Number(this.env.MAX_BYTES);
      const tooBig = { error: 'too large', message: `문서가 너무 큽니다(최대 ${Math.round(max / 1048576)}MB)` };
      if (Number(req.headers.get('Content-Length') || 0) > max) return json(tooBig, 413);
      const buf = await req.arrayBuffer();
      if (buf.byteLength > max) return json(tooBig, 413);
      if (buf.byteLength < 28) return json({ error: 'empty' }, 400);
      const n = meta.next;
      const chunks = await this.putBlob(n, buf);
      const by = (req.headers.get('X-Author') || '').slice(0, AUTHOR_MAX);
      meta.versions.push({ n, at: now, size: buf.byteLength, by, chunks, user });
      meta.next = n + 1;
      const keep = Number(this.env.KEEP_VERSIONS);
      while (meta.versions.length > keep) {
        const old = meta.versions.shift();
        await this.delBlob(old.n, old.chunks);
      }
      await this.state.storage.put('meta', meta);
      if (cur) await this.state.storage.put('lock', { ...cur, until: now + Number(this.env.LOCK_SECONDS) * 1000 });
      this.broadcast({ type: 'version', n, at: now, by });
      return json({ n, at: now }, 201);
    }

    if (path === '' && req.method === 'DELETE') {
      if (!isOwner) return user ? json({ error: 'forbidden', message: '문서 주인만 지울 수 있습니다' }, 403) : json({ error: 'login' }, 401);
      this.broadcast({ type: 'deleted' });
      for (const ws of this.state.getWebSockets()) { try { ws.close(1000, 'deleted'); } catch { /* 무시 */ } }
      await this.state.storage.deleteAll();
      return json({ ok: true });
    }

    return json({ error: 'not found' }, 404);
  }

  webSocketMessage(ws, msg) { if (msg === 'ping') ws.send('pong'); }
  webSocketClose(ws, code) { try { ws.close(code, 'bye'); } catch { /* 무시 */ } }
}

/* ---------- 하루 만들기 제한 (사용자별) ---------- */
export class Limiter {
  constructor(state) { this.state = state; }
  async fetch(req) {
    const max = Number(await req.text()) || 40;
    const day = new Date().toISOString().slice(0, 10);
    const cur = (await this.state.storage.get('c')) || { day, n: 0 };
    if (cur.day !== day) { cur.day = day; cur.n = 0; }
    if (cur.n >= max) return json({ ok: false });
    cur.n++;
    await this.state.storage.put('c', cur);
    return json({ ok: true, left: max - cur.n });
  }
}
