// 한글 편집기 클라우드 서버
// - 문서 내용·파일 이름·작성자 이름은 모두 편집기(내 PC)에서 암호화되어 온다. 서버는 열쇠가 없어 읽을 수 없다.
// - 문서마다 Durable Object(DocRoom) 하나: 고치기 권한 확인, 편집 잠금, 버전 목록, 실시간 알림(WebSocket)
// - 문서 파일(버전별)도 그 방의 저장소에 1MB 조각(c:<버전>:<순번>)으로 둔다 (R2 없이, 카드 등록 없는 무료 요금제)
//
// API
//   POST   /api/docs                    새 문서 → { id, editToken }
//   GET    /api/docs/:id                정보 → { versions:[{n,at,size,by}], lock:{by,until}|null }
//   GET    /api/docs/:id/v/:n           버전 n의 암호화된 파일
//   PUT    /api/docs/:id                새 버전 올리기 (X-Edit-Token, X-Lock-Id, X-Author)
//   POST   /api/docs/:id/lock           편집 잠금 잡기·연장 {by, lockId?} (X-Edit-Token)
//   DELETE /api/docs/:id/lock           잠금 풀기 (X-Lock-Id)
//   DELETE /api/docs/:id                문서 지우기 (X-Edit-Token)
//   GET    /api/docs/:id/live           WebSocket: {type:'version'|'lock', ...}

const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const AUTHOR_MAX = 600; // 암호화된 이름(base64) 최대 길이

function rand(bytes) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256(s) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function sameHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function cors(req, env) {
  const origin = req.headers.get('Origin') || '';
  const ok = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).includes(origin);
  return ok ? {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Edit-Token, X-Lock-Id, X-Author',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  } : { Vary: 'Origin' };
}
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const h = cors(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    const allowed = 'Access-Control-Allow-Origin' in h;
    if (!url.pathname.startsWith('/api/')) return new Response('한글 편집기 클라우드', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    // 허용된 편집기에서만 쓴다 (브라우저가 아닌 도구로 직접 부르는 것까지 막지는 못하지만 남의 웹페이지에서 쓰는 것은 막는다)
    if (!allowed) return json({ error: 'origin' }, 403, h);

    try {
      const parts = url.pathname.split('/').filter(Boolean); // api, docs, :id, ...
      if (parts[1] !== 'docs') return json({ error: 'not found' }, 404, h);

      if (parts.length === 2 && req.method === 'POST') {
        const ip = req.headers.get('CF-Connecting-IP') || 'local';
        const lim = env.LIMIT.get(env.LIMIT.idFromName(ip));
        const ok = await (await lim.fetch('https://limit/take', { method: 'POST', body: env.CREATES_PER_DAY })).json();
        if (!ok.ok) return json({ error: 'limit', message: '오늘 만들 수 있는 문서 수를 넘었습니다' }, 429, h);
        const id = rand(16);
        const editToken = rand(24);
        const room = env.ROOM.get(env.ROOM.idFromName(id));
        await room.fetch('https://room/init', { method: 'POST', body: JSON.stringify({ id, editHash: await sha256(editToken) }) });
        return json({ id, editToken }, 201, h);
      }

      const id = parts[2];
      if (!ID_RE.test(id || '')) return json({ error: 'bad id' }, 400, h);
      const room = env.ROOM.get(env.ROOM.idFromName(id));

      // 실시간 알림
      if (parts[3] === 'live') {
        if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'websocket only' }, 426, h);
        return room.fetch(req);
      }

      // 나머지는 문서 방이 처리
      const fwd = new Request(`https://room/${parts.slice(3).join('/')}`, req);
      const res = await room.fetch(fwd);
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(h)) out.headers.set(k, v);
      return out;
    } catch (e) {
      return json({ error: 'server', message: String(e && e.message || e) }, 500, h);
    }
  },
};

// ------------------------------------------------------------------
// 문서 방
// ------------------------------------------------------------------
const CHUNK = 1024 * 1024; // 저장소 값 하나의 한도(2MB)보다 작게

export class DocRoom {
  constructor(state, env) { this.state = state; this.env = env; }

  async putBlob(n, buf) {
    const u8 = new Uint8Array(buf);
    const count = Math.ceil(u8.length / CHUNK);
    const entries = {};
    for (let i = 0; i < count; i++) entries[`c:${n}:${i}`] = u8.slice(i * CHUNK, (i + 1) * CHUNK);
    const keys = Object.keys(entries);
    for (let i = 0; i < keys.length; i += 100) {
      const part = {};
      for (const k of keys.slice(i, i + 100)) part[k] = entries[k];
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
  async authorized(req, meta) {
    const t = req.headers.get('X-Edit-Token') || '';
    return !!t && sameHash(await sha256(t), meta.editHash);
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
      const { id, editHash } = await req.json();
      if (await this.meta()) return json({ error: 'exists' }, 409);
      await this.state.storage.put('meta', { id, editHash, created: now, versions: [], next: 1 });
      return json({ ok: true }, 201);
    }

    const meta = await this.meta();
    if (!meta) return json({ error: 'not found' }, 404);

    if (req.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

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
      return json({ versions: meta.versions, lock: lockInfo(await this.activeLock()), created: meta.created });
    }

    if (path === 'lock' && req.method === 'POST') {
      if (!(await this.authorized(req, meta))) return json({ error: 'forbidden' }, 403);
      const body = await req.json().catch(() => ({}));
      const by = String(body.by || '').slice(0, AUTHOR_MAX);
      const cur = await this.activeLock();
      if (cur && cur.lockId !== body.lockId) return json({ error: 'locked', lock: lockInfo(cur) }, 409);
      const lock = { lockId: cur ? cur.lockId : rand(16), by, until: now + Number(this.env.LOCK_SECONDS) * 1000 };
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

    if (path === '' && req.method === 'PUT') {
      if (!(await this.authorized(req, meta))) return json({ error: 'forbidden' }, 403);
      const cur = await this.activeLock();
      if (cur && cur.lockId !== req.headers.get('X-Lock-Id')) return json({ error: 'locked', lock: lockInfo(cur) }, 409);
      const max = Number(this.env.MAX_BYTES);
      const len = Number(req.headers.get('Content-Length') || 0);
      const tooBig = { error: 'too large', message: `문서가 너무 큽니다(최대 ${Math.round(max / 1048576)}MB)` };
      if (len > max) return json(tooBig, 413);
      const buf = await req.arrayBuffer();
      if (buf.byteLength > max) return json(tooBig, 413);
      if (buf.byteLength < 28) return json({ error: 'empty' }, 400);
      const n = meta.next;
      const chunks = await this.putBlob(n, buf);
      const by = (req.headers.get('X-Author') || '').slice(0, AUTHOR_MAX);
      meta.versions.push({ n, at: now, size: buf.byteLength, by, chunks });
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
      if (!(await this.authorized(req, meta))) return json({ error: 'forbidden' }, 403);
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

// ------------------------------------------------------------------
// 하루 만들기 제한 (접속 주소별)
// ------------------------------------------------------------------
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
