// 회원(아이디+비밀번호) 계정과 프로필
// - 계정마다 Durable Object(Account) 하나. 이름 = 계정 표시(principal): 아이디 회원은 "@아이디", Google 회원은 이메일.
//   "@"로 시작하는 표시는 이메일 형식이 될 수 없어 두 종류가 절대 겹치지 않는다.
// - 비밀번호: PBKDF2-SHA256 10만 번 + 계정별 소금 + 서버 후추(VAULT_SECRET에서 유도). 해시는 계정 DO 안에서 계산한다
//   (무료 요금제 Worker의 CPU 제한을 피하려고). 연속 5번 틀리면 잠시 잠근다.
// - 비밀번호를 잊으면 가입 때 한 번 보여 준 복구 코드로 되찾는다(메일 발송 도메인이 없어서). 쓰면 새 코드가 나온다.
// - 비밀번호를 바꾸거나 되찾거나 탈퇴하면 tv(표 버전)를 올려 그동안 나간 로그인 표를 모두 무효로 한다.
// - 탈퇴한 아이디는 다시 가입할 수 없다(남이 같은 아이디로 가입해 옛 문서 권한을 얻지 못하게).

export const USERNAME_RE = /^[a-z][a-z0-9_]{3,19}$/;
export const ID_PRINCIPAL_RE = /^@[a-z][a-z0-9_]{3,19}$/;
const RESERVED = new Set(['admin', 'administrator', 'root', 'system', 'support', 'help', 'hangul', 'hangul_editor', 'official', 'owner', 'test', 'null', 'undefined', 'google', 'cloudflare']);
const ITER = 100000; // Workers PBKDF2 최대값
const enc = new TextEncoder();
const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
function sameStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function checkPassword(pw, username) {
  if (typeof pw !== 'string' || pw.length < 8) return '비밀번호는 8자 이상이어야 합니다';
  if (pw.length > 128) return '비밀번호가 너무 깁니다(128자까지)';
  if (/^(.)\1+$/.test(pw)) return '같은 글자만 반복한 비밀번호는 쓸 수 없습니다';
  if (username && pw.toLowerCase().includes(username)) return '비밀번호에 아이디를 넣을 수 없습니다';
  if (/^(12345678|123456789|1234567890|password|qwerty12|11111111|abcd1234|qwer1234|password1|iloveyou)$/i.test(pw)) return '너무 흔한 비밀번호입니다';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return '비밀번호에 영문과 숫자를 함께 넣어 주세요';
  return null;
}
export function checkUsername(u) {
  if (!USERNAME_RE.test(u)) return '아이디는 영문 소문자로 시작하는 4~20자(영문 소문자·숫자·밑줄)여야 합니다';
  if (RESERVED.has(u)) return '쓸 수 없는 아이디입니다';
  return null;
}
export function cleanNick(n) {
  return String(n || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 20);
}
const AVATAR_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
export const AVATAR_MAX = 60000;

// 복구 코드: 25자(약 120비트), 헷갈리는 글자(0 O 1 I L) 뺌
const CODE_ABC = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function newRecoveryCode() {
  const r = crypto.getRandomValues(new Uint8Array(25));
  const s = [...r].map((x) => CODE_ABC[x % CODE_ABC.length]).join('');
  return s.match(/.{5}/g).join('-');
}
const normCode = (c) => String(c || '').toUpperCase().replace(/[^0-9A-Z]/g, '');

export class Account {
  constructor(state, env) { this.state = state; this.env = env; }

  async pepper() {
    if (!this.pep) {
      if (!this.env.VAULT_SECRET || this.env.VAULT_SECRET.length < 32) throw new Error('VAULT_SECRET이 설정되지 않았습니다');
      this.pep = await crypto.subtle.importKey('raw', enc.encode(`pw-pepper:${this.env.VAULT_SECRET}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    }
    return this.pep;
  }
  async hashPw(pw, salt, iter = ITER) {
    const base = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64u(salt), iterations: iter }, base, 256);
    return b64u(await crypto.subtle.sign('HMAC', await this.pepper(), bits));
  }
  async hashCode(code, salt) {
    return b64u(await crypto.subtle.sign('HMAC', await this.pepper(), enc.encode(`recovery:${salt}:${normCode(code)}`)));
  }
  async newSecret(pw) {
    const salt = b64u(crypto.getRandomValues(new Uint8Array(16)));
    return { salt, iter: ITER, hash: await this.hashPw(pw, salt) };
  }
  async newRecovery() {
    const code = newRecoveryCode();
    const salt = b64u(crypto.getRandomValues(new Uint8Array(16)));
    return { code, rec: { salt, hash: await this.hashCode(code, salt) } };
  }

  // 연속 실패 잠금: 5번째부터 1분, 2분, 4분 … 최대 60분
  locked(a, now) { return a.lockUntil && a.lockUntil > now ? a.lockUntil : 0; }
  async failed(a, now) {
    a.fails = (a.fails || 0) + 1;
    if (a.fails >= 5) a.lockUntil = now + Math.min(60, 2 ** (a.fails - 5)) * 60000;
    await this.state.storage.put('acct', a);
    return json({ error: 'bad', message: '아이디 또는 비밀번호가 맞지 않습니다' }, 401);
  }
  lockedRes(until) {
    const min = Math.max(1, Math.ceil((until - Date.now()) / 60000));
    return json({ error: 'locked', message: `여러 번 틀려서 잠시 잠겼습니다. ${min}분 뒤에 다시 해 주세요` }, 429);
  }

  async fetch(req) {
    const path = new URL(req.url).pathname;
    const body = req.method === 'GET' ? {} : await req.json().catch(() => ({}));
    const now = Date.now();
    const st = this.state.storage;
    const a = (await st.get('acct')) || null;
    // 탈퇴한 아이디(free)는 비어 있는 자리다: 다시 가입할 수 있지만 tv는 이어서 올라가 예전 로그인 표는 되살아나지 않는다
    const gone = !!(a && (a.deleted || a.free || a.deleting));
    const live = a && !gone;
    const tv = (a && a.tv) || 0;

    if (path === '/check') return json({ ok: !gone && tv === (body.tv || 0) });
    if (path === '/exists') return json({ exists: !!(live && a.kind === 'id') });
    if (path === '/tv') return json({ tv }); // Google 로그인 때 현재 표 버전

    if (path === '/create') {
      if (a && (!gone || a.deleting)) return json({ error: 'taken', message: '이미 있는 아이디입니다' }, 409);
      const ntv = gone ? tv + 1 : 0;
      const { code, rec } = await this.newRecovery();
      await st.deleteAll();
      await st.put('acct', { kind: 'id', username: body.username, ...(await this.newSecret(body.password)), rec, created: now, terms: now, tv: ntv, fails: 0 });
      await st.put('profile', { nick: cleanNick(body.nick) || body.username });
      return json({ tv: ntv, recovery: code }, 201);
    }
    // 이 아이디가 편집자로 들어간 문서 기록 (탈퇴할 때 그 문서들의 편집자 목록에서 뺀다)
    if (path === '/shared' || path === '/unshared') {
      if (!live) return json({ ok: false });
      const key = `shared:${body.id}`;
      if (path === '/shared') await st.put(key, now); else await st.delete(key);
      return json({ ok: true });
    }

    if (path === '/login' || path === '/recover') {
      if (!live || a.kind !== 'id') return json({ error: 'bad', message: path === '/login' ? '아이디 또는 비밀번호가 맞지 않습니다' : '아이디 또는 복구 코드가 맞지 않습니다' }, 401);
      const until = this.locked(a, now);
      if (until) return this.lockedRes(until);
      if (path === '/login') {
        if (!sameStr(await this.hashPw(String(body.password || ''), a.salt, a.iter), a.hash)) return this.failed(a, now);
        a.fails = 0; a.lockUntil = 0; a.lastLogin = now;
        await st.put('acct', a);
        return json({ tv, ...(await this.profile()) });
      }
      if (!sameStr(await this.hashCode(body.code, a.rec.salt), a.rec.hash)) {
        const r = await this.failed(a, now);
        return r.status === 401 ? json({ error: 'bad', message: '아이디 또는 복구 코드가 맞지 않습니다' }, 401) : r;
      }
      const { code, rec } = await this.newRecovery();
      Object.assign(a, await this.newSecret(body.password), { rec, fails: 0, lockUntil: 0, tv: tv + 1 });
      await st.put('acct', a);
      return json({ tv: a.tv, recovery: code, ...(await this.profile()) });
    }

    if (path === '/passwd') {
      if (!live || a.kind !== 'id') return json({ error: 'bad' }, 400);
      const until = this.locked(a, now);
      if (until) return this.lockedRes(until);
      if (!sameStr(await this.hashPw(String(body.old || ''), a.salt, a.iter), a.hash)) {
        const r = await this.failed(a, now);
        return r.status === 401 ? json({ error: 'bad', message: '지금 비밀번호가 맞지 않습니다' }, 401) : r;
      }
      Object.assign(a, await this.newSecret(body.password), { fails: 0, lockUntil: 0, tv: tv + 1 });
      await st.put('acct', a);
      return json({ tv: a.tv });
    }

    if (path === '/newcode') { // 복구 코드 다시 만들기 (로그인한 본인, 비밀번호 확인)
      if (!live || a.kind !== 'id') return json({ error: 'bad' }, 400);
      const until = this.locked(a, now);
      if (until) return this.lockedRes(until);
      if (!sameStr(await this.hashPw(String(body.password || ''), a.salt, a.iter), a.hash)) {
        const r = await this.failed(a, now);
        return r.status === 401 ? json({ error: 'bad', message: '비밀번호가 맞지 않습니다' }, 401) : r;
      }
      const { code, rec } = await this.newRecovery();
      a.rec = rec; a.fails = 0; a.lockUntil = 0;
      await st.put('acct', a);
      return json({ recovery: code });
    }

    if (path === '/profile' && req.method === 'GET') return json({ kind: a ? a.kind : 'google', terms: (a && a.terms) || 0, ...(await this.profile()) });
    if (path === '/profile' && req.method === 'PUT') {
      const p = (await st.get('profile')) || {};
      if ('nick' in body) p.nick = cleanNick(body.nick);
      if ('avatar' in body) {
        if (body.avatar === null || body.avatar === '') delete p.avatar;
        else if (typeof body.avatar === 'string' && body.avatar.length <= AVATAR_MAX && AVATAR_RE.test(body.avatar)) p.avatar = body.avatar;
        else return json({ error: 'bad avatar', message: '사진이 너무 크거나 형식이 맞지 않습니다' }, 400);
      }
      await st.put('profile', p);
      if (!a) await st.put('acct', { kind: 'google', created: now, tv: 0 });
      return json(await this.profile());
    }
    if (path === '/agree') {
      const acct = a && !a.deleted ? a : { kind: 'google', created: now, tv };
      acct.terms = now;
      await st.put('acct', acct);
      return json({ terms: now });
    }
    if (path === '/own' || path === '/unown') {
      const key = `own:${body.id}`;
      if (path === '/own') await st.put(key, now); else await st.delete(key);
      return json({ ok: true });
    }

    if (path === '/delete') {
      if (a && a.kind === 'id') {
        if (!live) return json({ error: 'bad' }, 400);
        const until = this.locked(a, now);
        if (until) return this.lockedRes(until);
        if (!sameStr(await this.hashPw(String(body.password || ''), a.salt, a.iter), a.hash)) {
          const r = await this.failed(a, now);
          return r.status === 401 ? json({ error: 'bad', message: '비밀번호가 맞지 않습니다' }, 401) : r;
        }
      }
      const owned = [...(await st.list({ prefix: 'own:' })).keys()].map((k) => k.slice(4));
      const shared = [...(await st.list({ prefix: 'shared:' })).keys()].map((k) => k.slice(7));
      const kind = a ? a.kind : 'google';
      await st.deleteAll();
      // 모든 정보를 지우고 표 버전만 올려 남은 로그인을 끊는다. 아이디는 비워 두어 다시 가입할 수 있다
      // (남의 문서 편집자 목록에서는 호출한 쪽이 이 아이디를 빼므로 새 가입자가 옛 권한을 얻지 못한다).
      // 아이디는 바로 풀지 않고 "지우는 중"으로 둔다 → 남의 문서에서 이 아이디를 다 뺀 뒤 /free로 푼다
      // (중간에 멈춰도 아이디가 풀리지 않을 뿐이라 안전하다)
      await st.put('acct', kind === 'id' ? { kind, deleting: true, tv: tv + 1 } : { kind, tv: tv + 1 });
      return json({ owned, shared });
    }
    if (path === '/free') {
      if (a && a.deleting) await st.put('acct', { kind: a.kind, free: true, tv });
      return json({ ok: true });
    }

    return json({ error: 'not found' }, 404);
  }

  async profile() {
    const p = (await this.state.storage.get('profile')) || {};
    return { nick: p.nick || '', avatar: p.avatar || '' };
  }
}
