// 한글 편집기 클라우드 서버
// - 문서 내용·파일 이름·작성자 이름은 모두 편집기(내 PC)에서 암호화되어 온다. 서버는 열쇠가 없어 읽을 수 없다.
// - 로그인: Google(OpenID Connect). 우리 서버는 비밀번호를 받지도 저장하지도 않는다.
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
//   GET    /api/me                             → { email, name }
//   POST   /api/docs                    새 문서 (로그인) → { id }
//   GET    /api/docs/:id                정보 → { versions, lock, created, you:{canEdit,isOwner}, editors? }
//   GET    /api/docs/:id/v/:n           버전 n의 암호화된 파일
//   PUT    /api/docs/:id                새 버전 (편집 권한 + 잠금, X-Lock-Id, X-Author)
//   POST   /api/docs/:id/lock           편집 잠금 잡기·연장 {by, lockId?}
//   DELETE /api/docs/:id/lock           잠금 풀기 (X-Lock-Id)
//   PUT    /api/docs/:id/editors        고칠 수 있는 사람 {editors:[email]} (주인)
//   DELETE /api/docs/:id                문서 지우기 (주인)
//   GET    /api/docs/:id/live           WebSocket: {type:'version'|'lock'|'deleted', ...}

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
  return verify(env, 'ses', a.slice(7));
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
  const user = { sub: lc.sub, email: lc.email, name: lc.name };
  const token = await sign(env, 'ses', { ...user, exp: Date.now() + SESSION_DAYS * 86400 * 1000 });
  return json({ token, user: { email: user.email, name: user.name } });
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
      if (!url.pathname.startsWith('/api/')) return new Response('한글 편집기 클라우드', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      // 허용된 편집기 화면에서만 쓴다
      if (!('Access-Control-Allow-Origin' in h)) return json({ error: 'origin' }, 403, h);

      if (url.pathname === '/api/auth/exchange' && req.method === 'POST') return withCors(await authExchange(req, env), h);
      const ses = await sessionOf(req, env);
      if (url.pathname === '/api/me') return ses ? json({ email: ses.email, name: ses.name }, 200, h) : json({ error: 'login' }, 401, h);

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
      const fwd = new Request(`https://room/${parts.slice(3).join('/')}`, { method: req.method, headers, body: req.body });
      return withCors(await room.fetch(fwd), h);
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
    const lockInfo = (l) => (l ? { by: l.by, until: l.until } : null);

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
      if (cur && cur.lockId !== body.lockId) return json({ error: 'locked', lock: lockInfo(cur) }, 409);
      const lock = { lockId: cur ? cur.lockId : rand(16), by, user, until: now + Number(this.env.LOCK_SECONDS) * 1000 };
      await this.state.storage.put('lock', lock);
      if (!cur) this.broadcast({ type: 'lock', lock: lockInfo(lock) });
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

    if (path === 'editors' && req.method === 'PUT') {
      if (!isOwner) return user ? json({ error: 'forbidden', message: '문서 주인만 바꿀 수 있습니다' }, 403) : json({ error: 'login' }, 401);
      const body = await req.json().catch(() => ({}));
      const list = [...new Set((Array.isArray(body.editors) ? body.editors : []).map((e) => String(e).trim().toLowerCase()))]
        .filter((e) => EMAIL_RE.test(e) && e !== meta.owner).slice(0, 50);
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
