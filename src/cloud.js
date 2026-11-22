// 한글 편집기 클라우드 (서버: cloud/src/index.js)
// - 문서·파일 이름·작성자 이름은 이 PC에서 AES-GCM으로 잠근 뒤 올린다. 열쇠는 공유 링크의 # 뒤에만 있어 서버는 내용을 볼 수 없다.
// - 링크: <웹판>#cloud=<문서id>.<열쇠>   (보기는 링크만 있으면, 고치기는 로그인 + 문서 주인이 지정한 사람만)
// - 로그인: Google. 비밀번호는 우리 서버에 오지 않는다. 로그인 창에서 돌아온 1회용 코드는 이 편집기만 아는 비밀값(PKCE)과 함께여야 쓸 수 있다.
// - 한 번에 한 사람만 고친다(편집 잠금, 30초마다 연장). 저장할 때마다 버전이 쌓이고, 보는 사람에게 알림이 간다.
// - 내 문서함(기본 켜짐): 로그인하면 연·저장한 클라우드 문서의 열쇠를 서버 보관함에 둔다(서버 비밀키로 다시 잠금).
//   어느 PC에서나 목록에서 바로 연다. 끄면 보관 열쇠를 모두 지우고 링크로만 연다(서버도 못 여는 최고 보안).

const WEB_URL = 'https://sion-dev404.github.io/hangul-editor/';
// 배포한 서버 주소 (wrangler deploy 뒤에 적는다). 개발 서버(5173·5198·5199)에서는 로컬 서버(wrangler dev)를 쓴다.
const PROD_API = 'https://hangul-editor-cloud.hangul-editor-cloud.workers.dev';
const DEV = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && ['5173', '5198', '5199'].includes(location.port);
const API = DEV ? 'http://127.0.0.1:8787' : PROD_API;

let ctx = null;
let s = null; // 지금 열린 클라우드 문서
const HEARTBEAT = 30000;

/* ---------- 암호화 ---------- */
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (str) => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4)), (c) => c.charCodeAt(0));
async function newKey() {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  return { key, str: b64u(await crypto.subtle.exportKey('raw', key)) };
}
const importKey = (str) => crypto.subtle.importKey('raw', unb64u(str), 'AES-GCM', false, ['encrypt', 'decrypt']);
async function seal(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return out;
}
async function unseal(key, data) {
  const d = new Uint8Array(data);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: d.subarray(0, 12) }, key, d.subarray(12)));
}
// 문서 묶음: [머리 길이 4바이트][머리 JSON {name, format}][파일]
async function packDoc(key, { bytes, name, format }) {
  const head = new TextEncoder().encode(JSON.stringify({ v: 1, name, format }));
  const all = new Uint8Array(4 + head.length + bytes.length);
  new DataView(all.buffer).setUint32(0, head.length);
  all.set(head, 4); all.set(bytes, 4 + head.length);
  return seal(key, all);
}
async function unpackDoc(key, data) {
  const all = await unseal(key, data);
  const n = new DataView(all.buffer, all.byteOffset).getUint32(0);
  const head = JSON.parse(new TextDecoder().decode(all.subarray(4, 4 + n)));
  return { ...head, bytes: all.slice(4 + n) };
}
const sealText = async (key, t) => b64u(await seal(key, new TextEncoder().encode(t)));
async function openText(key, t) {
  if (!t) return '';
  try { return new TextDecoder().decode(await unseal(key, unb64u(t))); } catch { return '(알 수 없음)'; }
}

/* ---------- 로그인 ---------- */
const TOKEN_KEY = 'hangul-editor-cloud-session';
let auth = null; // { token, user:{email,name} }
function loadAuth() {
  try { auth = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null'); } catch { auth = null; }
}
function saveAuth(a) {
  auth = a;
  try { if (a) localStorage.setItem(TOKEN_KEY, JSON.stringify(a)); else localStorage.removeItem(TOKEN_KEY); } catch { /* 무시 */ }
}
export const user = () => auth?.user || null;
const myName = () => auth?.user?.name || auth?.user?.email || '이름 없음';

let loginWait = null;
// 로그인 창(아이디 로그인 · 회원가입 · 비밀번호 찾기 · Google). 로그인하면 true, 닫으면 false.
export function login() {
  if (!API) { ctx.toast('클라우드 서버가 아직 준비되지 않았습니다'); return Promise.resolve(false); }
  if (auth) return Promise.resolve(true);
  return new Promise((resolve) => loginDialog(resolve));
}
// 로그인이 끝난 뒤 공통: 프로필을 받고, 약관에 아직 동의하지 않았으면(Google 첫 로그인) 동의를 받는다
async function afterLogin(r, how) {
  saveAuth({ token: r.token, user: r.user });
  await refreshMe();
  if (auth && auth.user.agreed === false && !(await consentDialog())) { await logout(true); ctx.toast('동의하지 않아 로그인하지 않았습니다'); return false; }
  if (!auth) return false;
  ctx.toast(`${auth.user.name || auth.user.email}님, ${how}`);
  if (s) await refreshRights();
  return true;
}
async function refreshMe() {
  if (!auth) return;
  try {
    const res = await call('/api/me');
    if (!res.ok) return;
    const me = await jsonOf(res);
    saveAuth({ token: auth.token, user: { email: me.email, name: me.name, kind: me.kind, avatar: me.avatar, agreed: me.agreed } });
  } catch { /* 다음에 */ }
}
const termsUrl = () => `${API}/terms`;
const privacyUrl = () => `${API}/privacy`;
async function postJson(path, body) {
  const res = await call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { res, r: await jsonOf(res) };
}

function loginDialog(resolve, start = 'login') {
  let done = false;
  const finish = (v) => { if (!done) { done = true; resolve(v); } };
  const body = el(`<div class="tabs"><button data-tab="login">로그인</button><button data-tab="signup">회원가입</button></div>
    <div data-pane="login">
      <label class="f">아이디<input data-u autocomplete="username" autocapitalize="off" spellcheck="false"></label>
      <label class="f">비밀번호<input data-p type="password" autocomplete="current-password"></label>
      <div class="err" data-err></div>
      <button class="btn wide" data-go>로그인</button>
      <div class="links"><button class="lnk" data-forgot>비밀번호를 잊었어요</button><button class="lnk" data-tosign>처음이면 회원가입</button></div>
      <div class="or"><span>또는</span></div>
      <button class="btn g" data-google>${G_MARK} Google 계정으로 로그인</button>
    </div>
    <div data-pane="signup" hidden>
      <label class="f">아이디 <small>영문 소문자로 시작, 4~20자 (영문 소문자·숫자·_)</small><input data-u autocomplete="username" autocapitalize="off" spellcheck="false" maxlength="20"></label>
      <label class="f">비밀번호 <small>8자 이상, 영문과 숫자를 함께</small><input data-p type="password" autocomplete="new-password"></label>
      <label class="f">비밀번호 확인<input data-p2 type="password" autocomplete="new-password"></label>
      <label class="f">이름 <small>편집 중 표시에 쓰여요 (별명 가능)</small><input data-n maxlength="20"></label>
      <label class="ck"><input type="checkbox" data-all> <b>모두 동의</b></label>
      <label class="ck"><input type="checkbox" data-t1> (필수) <button class="lnk" data-terms>이용약관</button>에 동의합니다</label>
      <label class="ck"><input type="checkbox" data-t2> (필수) <button class="lnk" data-privacy>개인정보 수집·이용</button>에 동의합니다</label>
      <div class="err" data-err></div>
      <button class="btn wide" data-go>가입하기</button>
      <div class="note">메일 인증을 쓰지 않아요. 가입하면 <b>복구 코드</b>를 한 번 보여 드리니, 비밀번호를 잊을 때를 대비해 꼭 적어 두세요.</div>
    </div>
    <div data-pane="forgot" hidden>
      <div style="margin-bottom:6px">가입할 때 받은 <b>복구 코드</b>로 새 비밀번호를 정합니다.</div>
      <label class="f">아이디<input data-u autocomplete="username" autocapitalize="off" spellcheck="false"></label>
      <label class="f">복구 코드<input data-c placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" autocapitalize="characters" spellcheck="false"></label>
      <label class="f">새 비밀번호 <small>8자 이상, 영문과 숫자를 함께</small><input data-p type="password" autocomplete="new-password"></label>
      <label class="f">새 비밀번호 확인<input data-p2 type="password" autocomplete="new-password"></label>
      <div class="err" data-err></div>
      <button class="btn wide" data-go>비밀번호 다시 정하기</button>
      <div class="links"><button class="lnk" data-back>로그인으로 돌아가기</button></div>
    </div>`);
  const d = dialog('클라우드 계정', body);
  let moving = false; // 성공해서 다음 단계로 넘어갈 때는 닫혀도 '취소'가 아니다
  d.addEventListener('close', () => { if (!moving) finish(false); });
  const panes = { login: d.querySelector('[data-pane=login]'), signup: d.querySelector('[data-pane=signup]'), forgot: d.querySelector('[data-pane=forgot]') };
  const show = (name) => {
    for (const [k, p] of Object.entries(panes)) p.hidden = k !== name;
    d.querySelectorAll('[data-tab]').forEach((t) => t.classList.toggle('on', t.dataset.tab === name));
    d.querySelector('.hd b').textContent = name === 'signup' ? '회원가입' : name === 'forgot' ? '비밀번호 찾기' : '클라우드 계정';
    panes[name].querySelector('input')?.focus();
  };
  d.querySelectorAll('[data-tab]').forEach((t) => t.addEventListener('click', () => show(t.dataset.tab)));
  d.querySelector('[data-forgot]').addEventListener('click', () => show('forgot'));
  d.querySelector('[data-tosign]').addEventListener('click', () => show('signup'));
  d.querySelector('[data-back]').addEventListener('click', () => show('login'));
  d.querySelector('[data-terms]').addEventListener('click', (e) => { e.preventDefault(); window.open(termsUrl(), '_blank'); });
  d.querySelector('[data-privacy]').addEventListener('click', (e) => { e.preventDefault(); window.open(privacyUrl(), '_blank'); });
  const all = d.querySelector('[data-all]'); const t1 = d.querySelector('[data-t1]'); const t2 = d.querySelector('[data-t2]');
  all.addEventListener('change', () => { t1.checked = t2.checked = all.checked; });
  [t1, t2].forEach((c) => c.addEventListener('change', () => { all.checked = t1.checked && t2.checked; }));
  d.querySelector('[data-google]').addEventListener('click', async () => {
    moving = true; d.close(); finish(await loginGoogle());
  });
  // 한 번에 한 요청만
  const busyRun = (pane, fn) => async () => {
    const btn = pane.querySelector('[data-go]'); const err = pane.querySelector('[data-err]');
    if (btn.disabled) return;
    err.textContent = ''; btn.disabled = true;
    try { const m = await fn(); if (m) err.textContent = m; } catch (e) { err.textContent = e.message || '잠시 뒤에 다시 해 주세요'; } finally { btn.disabled = false; }
  };
  const v = (pane, sel) => pane.querySelector(sel).value;
  const P = panes;
  const doLogin = busyRun(P.login, async () => {
    const username = v(P.login, '[data-u]').trim(); const password = v(P.login, '[data-p]');
    if (!username || !password) return '아이디와 비밀번호를 넣어 주세요';
    const { res, r } = await postJson('/api/auth/login', { username, password });
    if (!res.ok) return r.message || '로그인하지 못했습니다';
    moving = true; d.close(); finish(await afterLogin(r, '반갑습니다'));
    return null;
  });
  const doSignup = busyRun(P.signup, async () => {
    const username = v(P.signup, '[data-u]').trim().toLowerCase(); const password = v(P.signup, '[data-p]');
    if (!/^[a-z][a-z0-9_]{3,19}$/.test(username)) return '아이디는 영문 소문자로 시작하는 4~20자(영문 소문자·숫자·_)로 만들어 주세요';
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return '비밀번호는 8자 이상, 영문과 숫자를 함께 넣어 주세요';
    if (password !== v(P.signup, '[data-p2]')) return '비밀번호 확인이 맞지 않습니다';
    if (!t1.checked || !t2.checked) return '필수 항목에 동의해 주세요';
    const { res, r } = await postJson('/api/auth/signup', { username, password, nick: v(P.signup, '[data-n]').trim(), agree: true });
    if (!res.ok) return r.message || '가입하지 못했습니다';
    moving = true; d.close();
    await recoveryCodeDialog(r.recovery, `@${username} 가입을 마쳤습니다`);
    finish(await afterLogin(r, '가입을 환영합니다'));
    return null;
  });
  const doRecover = busyRun(P.forgot, async () => {
    const username = v(P.forgot, '[data-u]').trim(); const code = v(P.forgot, '[data-c]').trim(); const password = v(P.forgot, '[data-p]');
    if (!username || !code) return '아이디와 복구 코드를 넣어 주세요';
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return '새 비밀번호는 8자 이상, 영문과 숫자를 함께 넣어 주세요';
    if (password !== v(P.forgot, '[data-p2]')) return '새 비밀번호 확인이 맞지 않습니다';
    const { res, r } = await postJson('/api/auth/recover', { username, code, password });
    if (!res.ok) return r.message || '되찾지 못했습니다';
    moving = true; d.close();
    await recoveryCodeDialog(r.recovery, '비밀번호를 새로 정했습니다. 쓴 복구 코드는 더는 쓸 수 없어 새 코드를 드립니다');
    finish(await afterLogin(r, '비밀번호를 새로 정했습니다'));
    return null;
  });
  const bind = (pane, fn) => {
    pane.querySelector('[data-go]').addEventListener('click', fn);
    pane.querySelectorAll('input:not([type=checkbox])').forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fn(); } }));
  };
  bind(P.login, doLogin); bind(P.signup, doSignup); bind(P.forgot, doRecover);
  show(start);
}

// 복구 코드는 한 번만 보여 준다. "적어 두었어요"를 눌러야 닫힌다.
function recoveryCodeDialog(code, title) {
  return new Promise((resolve) => {
    const body = el(`<div>${esc(title)}.</div>
      <div class="sec"><div class="t">복구 코드 <small>비밀번호를 잊었을 때 이 코드로만 되찾을 수 있어요</small></div>
        <div class="code" data-code>${esc(code)}</div>
        <div class="r" style="margin-top:8px"><button class="btn sub" data-copy>복사</button><button class="btn sub" data-file>파일로 저장</button></div></div>
      <div class="note">⚠️ 이 코드는 <b>지금 한 번만</b> 보여 드립니다. 메일 인증이 없어서, 비밀번호와 이 코드를 모두 잃으면 계정을 되찾을 수 없어요. 종이에 적거나 안전한 곳에 저장해 두세요.</div>
      <label class="ck" style="margin-top:12px"><input type="checkbox" data-ok> 복구 코드를 안전한 곳에 적어 두었어요</label>
      <button class="btn wide" data-done disabled style="margin-top:8px">확인</button>`);
    const d = dialog('복구 코드', body);
    d.querySelector('.x').remove();
    d.addEventListener('cancel', (e) => e.preventDefault()); // Esc로 닫지 않게
    d.querySelector('[data-copy]').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(code); ctx.toast('복구 코드를 복사했습니다'); } catch { ctx.toast('복사하지 못했습니다. 직접 적어 주세요'); }
    });
    d.querySelector('[data-file]').addEventListener('click', () => {
      const who = auth?.user?.email || '';
      const blob = new Blob([`한글 편집기 클라우드 복구 코드\r\n\r\n${who ? `계정: ${who}\r\n` : ''}복구 코드: ${code}\r\n만든 날: ${new Date().toLocaleString('ko-KR')}\r\n\r\n비밀번호를 잊었을 때 로그인 창의 "비밀번호를 잊었어요"에서 씁니다. 다른 사람에게 보여 주지 마세요.\r\n`], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = '한글편집기-복구코드.txt';
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
    const ok = d.querySelector('[data-ok]'); const done = d.querySelector('[data-done]');
    ok.addEventListener('change', () => { done.disabled = !ok.checked; });
    done.addEventListener('click', () => { d.close(); resolve(); });
  });
}

// Google 회원의 첫 로그인: 이용약관·개인정보 동의
function consentDialog() {
  return new Promise((resolve) => {
    const body = el(`<div>클라우드를 쓰려면 아래 내용에 동의해 주세요.</div>
      <label class="ck" style="margin-top:12px"><input type="checkbox" data-all> <b>모두 동의</b></label>
      <label class="ck"><input type="checkbox" data-t1> (필수) <button class="lnk" data-terms>이용약관</button>에 동의합니다</label>
      <label class="ck"><input type="checkbox" data-t2> (필수) <button class="lnk" data-privacy>개인정보 수집·이용</button>에 동의합니다</label>
      <div class="r" style="margin-top:12px;justify-content:flex-end"><button class="btn sub" data-no>동의하지 않음</button><button class="btn" data-yes disabled>동의하고 시작</button></div>`);
    const d = dialog('약관 동의', body);
    let answered = false;
    const end = (v) => { if (!answered) { answered = true; resolve(v); } };
    d.addEventListener('close', () => end(false));
    const all = d.querySelector('[data-all]'); const t1 = d.querySelector('[data-t1]'); const t2 = d.querySelector('[data-t2]'); const yes = d.querySelector('[data-yes]');
    const sync = () => { yes.disabled = !(t1.checked && t2.checked); all.checked = t1.checked && t2.checked; };
    all.addEventListener('change', () => { t1.checked = t2.checked = all.checked; sync(); });
    [t1, t2].forEach((c) => c.addEventListener('change', sync));
    d.querySelector('[data-terms]').addEventListener('click', (e) => { e.preventDefault(); window.open(termsUrl(), '_blank'); });
    d.querySelector('[data-privacy]').addEventListener('click', (e) => { e.preventDefault(); window.open(privacyUrl(), '_blank'); });
    d.querySelector('[data-no]').addEventListener('click', () => d.close());
    yes.addEventListener('click', async () => {
      const { res } = await postJson('/api/account/agree', {});
      if (!res.ok) { ctx.toast('동의를 기록하지 못했습니다'); return; }
      auth.user.agreed = true; saveAuth(auth);
      end(true); d.close();
    });
  });
}

// Google 로그인: 브라우저(웹판은 작은 창, 설치형은 기본 브라우저)에서 Google 로그인 → 1회용 코드 → 세션
async function loginGoogle() {
  if (loginWait) return loginWait;
  loginWait = (async () => {
    const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const ret = location.origin;
    let start = `${API}/auth/google/start?challenge=${challenge}&ret=${encodeURIComponent(ret)}`;
    if (DEV) {
      // 개발용: Google 대신 시험 서버의 가짜 로그인 (배포 서버에는 없음)
      const email = (window.__devLoginEmail || prompt('시험용 로그인 이메일', 'test@example.com') || '').trim();
      if (!email) return false;
      start = `${API}/auth/dev/start?challenge=${challenge}&ret=${encodeURIComponent(ret)}&email=${encodeURIComponent(email)}`;
    }
    const code = await new Promise((resolve) => {
      let offDesk = null;
      const done = (c) => { clearTimeout(timer); window.removeEventListener('message', onMsg); offDesk?.(); resolve(c); };
      const timer = setTimeout(() => done(null), 5 * 60 * 1000);
      const onMsg = (e) => { if (e.origin === new URL(API).origin && e.data?.type === 'hangul-auth' && typeof e.data.code === 'string') done(e.data.code); };
      window.addEventListener('message', onMsg);
      if (ctx.desktop?.onAuthCode) offDesk = ctx.desktop.onAuthCode((c) => done(c));
      const w = window.open(start, 'hangulLogin', 'popup,width=500,height=680');
      if (!w && !ctx.desktop) { ctx.toast('로그인 창이 막혔습니다. 팝업을 허용해 주세요'); done(null); }
      ctx.toast('로그인 창에서 Google 계정을 골라 주세요');
    });
    if (!code) { ctx.toast('로그인하지 못했습니다'); return false; }
    const res = await fetch(`${API}/api/auth/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, verifier }) });
    const r = await res.json().catch(() => ({}));
    if (!res.ok || !r.token) { ctx.toast('로그인하지 못했습니다'); return false; }
    return afterLogin(r, '로그인했습니다');
  })().finally(() => { loginWait = null; });
  return loginWait;
}
export async function logout(quiet = false) {
  if (s?.editing) await releaseLock();
  saveAuth(null);
  vaultOn = true;
  if (s) { s.canEdit = false; s.isOwner = false; refreshBar(); }
  if (!quiet) ctx.toast('로그아웃했습니다');
}

/* ---------- 서버 ---------- */
async function call(path, opt = {}) {
  if (!API) throw new Error('클라우드 서버가 아직 준비되지 않았습니다');
  const headers = { ...(opt.headers || {}) };
  if (auth?.token) headers.Authorization = `Bearer ${auth.token}`;
  if (s?.lockId && opt.lock) headers['X-Lock-Id'] = s.lockId;
  let res;
  try { res = await fetch(API + path, { method: opt.method || 'GET', headers, body: opt.body, keepalive: opt.keepalive }); }
  catch { throw new Error('클라우드에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요'); }
  if (res.status === 401 && auth) {
    // 세션이 끝났다 (비밀번호가 틀렸다는 401은 세션과 관계없으니 로그인을 유지한다)
    const j = await res.clone().json().catch(() => ({}));
    if (j.error !== 'bad') saveAuth(null);
  }
  return res;
}
const jsonOf = async (res) => { try { return await res.json(); } catch { return {}; } };

/* ---------- 링크 ---------- */
export function linkOf() { return s ? `${WEB_URL}#cloud=${s.id}.${s.keyStr}` : ''; }
export function parseLink(text) {
  const m = /#cloud=([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})/.exec(String(text || ''));
  return m ? { id: m[1], keyStr: m[2] } : null;
}

/* ---------- 상태 줄 · 대화 상자 ---------- */
const CSS = `
#cloudBar{position:fixed;left:50%;bottom:38px;transform:translateX(-50%);z-index:900;display:none;align-items:center;gap:10px;
  background:#fff;border:1px solid #c9d6ea;border-radius:22px;box-shadow:0 6px 22px rgba(20,40,80,.16);padding:6px 8px 6px 14px;
  font:13px/1.3 "Malgun Gothic",sans-serif;color:#1d2430;max-width:calc(100vw - 32px)}
#cloudBar.on{display:flex}
#cloudBar .dot{width:9px;height:9px;border-radius:50%;background:#1f8a4c;flex:none}
#cloudBar.ro .dot{background:#b7740a}
#cloudBar.warn{border-color:#f0c36d;background:#fffaf0}
#cloudBar .msg{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#cloudBar button{border:0;border-radius:16px;padding:6px 12px;font:inherit;font-weight:700;cursor:pointer;background:#e8f0fc;color:#2f6fd6;white-space:nowrap}
#cloudBar button.pri{background:#2f6fd6;color:#fff}
#cloudDlg{border:0;border-radius:14px;padding:0;width:min(560px,calc(100vw - 32px));box-shadow:0 18px 50px rgba(20,40,80,.28);font:13.5px/1.5 "Malgun Gothic",sans-serif;color:#1d2430}
#cloudDlg::backdrop{background:rgba(20,30,50,.35)}
#cloudDlg .hd{display:flex;align-items:center;justify-content:space-between;padding:16px 20px 6px}
#cloudDlg .hd b{font-size:17px}
#cloudDlg .x{border:0;background:none;font-size:18px;color:#8a93a3;cursor:pointer;padding:4px 8px}
#cloudDlg .bd{padding:6px 20px 18px}
#cloudDlg .sec{margin-top:14px}
#cloudDlg .sec>.t{font-weight:700;margin-bottom:4px}
#cloudDlg .sec>.t small{font-weight:400;color:#5b6575;margin-left:6px}
#cloudDlg .r{display:flex;gap:6px;align-items:center}
#cloudDlg input{flex:1;min-width:0;border:1px solid #d5dbe4;border-radius:8px;padding:8px 10px;font:inherit}
#cloudDlg input[readonly]{font:12px Consolas,monospace;color:#3a4352;background:#f7f8fa}
#cloudDlg .btn{border:0;border-radius:8px;padding:8px 14px;font:inherit;font-weight:700;cursor:pointer;background:#2f6fd6;color:#fff;white-space:nowrap}
#cloudDlg .btn.sub{background:#e8f0fc;color:#2f6fd6}
#cloudDlg .btn.g{display:flex;align-items:center;gap:10px;justify-content:center;width:100%;padding:12px;background:#fff;color:#1d2430;border:1px solid #d5dbe4;font-size:14.5px}
#cloudDlg .note{margin-top:14px;background:#f3f5f8;border-radius:8px;padding:10px 12px;color:#4a5363;font-size:12.5px}
#cloudDlg .chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
#cloudDlg .chip{display:inline-flex;align-items:center;gap:4px;background:#e8f0fc;color:#1d2430;border-radius:14px;padding:3px 4px 3px 10px;font-size:12.5px}
#cloudDlg .chip button{border:0;background:none;color:#5b6575;cursor:pointer;font-size:13px;padding:0 4px}
#cloudDlg .me{display:flex;align-items:center;justify-content:space-between;gap:8px;background:#f7f8fa;border-radius:8px;padding:8px 12px}
#cloudDlg table{width:100%;border-collapse:collapse;margin-top:6px}
#cloudDlg td,#cloudDlg th{padding:7px 6px;border-bottom:1px solid #e6e9ee;text-align:left}
#cloudDlg th{font-size:12px;color:#5b6575;font-weight:700}
#cloudDlg td.acts{text-align:right;white-space:nowrap}
#cloudDlg td.acts .btn{padding:5px 10px;font-size:12px}
#cloudDlg .list{max-height:min(50vh,380px);overflow:auto}
#cloudDlg{max-height:calc(100vh - 32px);overflow:auto}
#cloudDlg .tabs{display:flex;gap:4px;border-bottom:1px solid #e1e5ea;margin:0 0 12px}
#cloudDlg .tabs button{flex:1;border:0;background:none;padding:9px 0;font:inherit;font-weight:700;color:#5b6575;cursor:pointer;border-bottom:3px solid transparent}
#cloudDlg .tabs button.on{color:#2f6fd6;border-bottom-color:#2f6fd6}
#cloudDlg label.f{display:flex;flex-direction:column;gap:3px;margin-top:9px;font-weight:700;font-size:13px}
#cloudDlg label.f small{font-weight:400;color:#5b6575}
#cloudDlg label.f input{flex:none;font-weight:400;font-size:14px;padding:9px 10px}
#cloudDlg label.ck{display:flex;align-items:center;gap:7px;margin-top:8px;cursor:pointer}
#cloudDlg label.ck input{flex:none;width:17px;height:17px;margin:0}
#cloudDlg .btn.wide{width:100%;margin-top:12px;padding:11px;font-size:14.5px}
#cloudDlg .btn:disabled{opacity:.5;cursor:default}
#cloudDlg .err{color:#c0392b;font-size:12.5px;min-height:0;margin-top:6px}
#cloudDlg .err:empty{display:none}
#cloudDlg .links{display:flex;justify-content:space-between;gap:10px;margin-top:10px;flex-wrap:wrap}
#cloudDlg .lnk{border:0;background:none;padding:0;color:#2f6fd6;font:inherit;font-size:12.5px;cursor:pointer;text-decoration:underline}
#cloudDlg label.ck .lnk{font-size:inherit}
#cloudDlg .lnk.danger{color:#c0392b}
#cloudDlg .or{display:flex;align-items:center;gap:10px;color:#8a93a3;font-size:12px;margin:14px 0 10px}
#cloudDlg .or::before,#cloudDlg .or::after{content:"";flex:1;border-top:1px solid #e1e5ea}
#cloudDlg .code{font:700 19px/1.4 Consolas,monospace;letter-spacing:1px;text-align:center;background:#f3f6fb;border:1px dashed #9db6dd;border-radius:10px;padding:14px 8px;user-select:all;word-break:break-all}
#cloudDlg .who{display:flex;align-items:center;gap:10px;min-width:0}
#cloudDlg .av{border-radius:50%;flex:none;object-fit:cover;background:#2f6fd6;color:#fff;display:inline-grid;place-items:center;font-weight:700}
#cloudDlg ul.warn{margin:10px 0;padding-left:18px;color:#4a5363;font-size:12.5px}
#cloudDlg ul.warn li{margin:3px 0}
`;
// Google 로고 대신 직접 그린 단순한 표시 (상표 그림은 쓰지 않는다)
const G_MARK = '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="8" fill="none" stroke="#5b6575" stroke-width="1.6"/><text x="9" y="13" text-anchor="middle" font-size="10" font-weight="700" fill="#5b6575" font-family="Arial">G</text></svg>';
let bar = null;
function ensureUi() {
  if (bar) return;
  const st = document.createElement('style'); st.textContent = CSS; document.head.append(st);
  bar = document.createElement('div'); bar.id = 'cloudBar';
  document.body.append(bar);
}
function showBar(text, { ro = false, warn = false, buttons = [] } = {}) {
  ensureUi();
  bar.className = `on${ro ? ' ro' : ''}${warn ? ' warn' : ''}`;
  bar.replaceChildren();
  const dot = document.createElement('span'); dot.className = 'dot';
  const msg = document.createElement('span'); msg.className = 'msg'; msg.textContent = text;
  bar.append(dot, msg);
  for (const b of buttons) {
    const el = document.createElement('button');
    el.textContent = b.label; if (b.primary) el.className = 'pri';
    el.addEventListener('click', b.run);
    bar.append(el);
  }
}
function hideBar() { if (bar) bar.className = ''; }
function refreshBar() {
  if (!s) { hideBar(); return; }
  if (s.editing) {
    showBar(`클라우드 문서 · 내가 편집 중${s.savedAt ? ` · ${s.savedAt} 저장` : ''}`, { buttons: [
      { label: '클라우드에 저장', primary: true, run: () => saveToCloud() },
      { label: '공유', run: () => shareDialog() },
    ] });
  } else if (s.canEdit && s.lockMine) {
    showBar('다른 PC(또는 창)에서 내가 편집 중이에요', { ro: true, buttons: [{ label: '여기서 편집', primary: true, run: () => startEditing(true, true) }] });
  } else if (s.canEdit) {
    if (s.lockBy) showBar(`${s.lockBy}님이 편집 중입니다 · 지금은 보기만 할 수 있어요`, { ro: true, buttons: [{ label: '버전 기록', run: () => versionsDialog() }] });
    else showBar('클라우드 문서 · 지금 아무도 편집하지 않아요', { ro: true, buttons: [{ label: '편집 시작', primary: true, run: () => startEditing(true) }] });
  } else {
    const who = s.lockBy ? `${s.lockBy}님이 편집 중 · ` : '클라우드 문서 · ';
    if (!auth) showBar(`${who}보기 전용`, { ro: true, buttons: [{ label: '로그인해서 고치기', primary: true, run: () => login() }, { label: '버전 기록', run: () => versionsDialog() }] });
    else showBar(`${who}보기 전용 (고칠 권한이 없어요)`, { ro: true, buttons: [{ label: '버전 기록', run: () => versionsDialog() }] });
  }
}

function dialog(title, body) {
  ensureUi();
  document.getElementById('cloudDlg')?.remove();
  const d = document.createElement('dialog'); d.id = 'cloudDlg';
  d.innerHTML = '<div class="hd"><b></b><button class="x" title="닫기">✕</button></div><div class="bd"></div>';
  d.querySelector('b').textContent = title;
  d.querySelector('.bd').append(body);
  d.querySelector('.x').addEventListener('click', () => d.close());
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content; };
const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
async function copy(text) {
  try { await navigator.clipboard.writeText(text); ctx.toast('링크를 복사했습니다'); }
  catch { ctx.toast('복사하지 못했습니다. 링크를 직접 선택해 복사해 주세요'); }
}

// 사진: 고른 그림을 가운데 정사각형으로 잘라 128px JPEG로 줄인다 (서버 한도 60KB 안쪽)
function pickAvatar() {
  return new Promise((resolve) => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/webp,image/gif';
    inp.addEventListener('change', async () => {
      const f = inp.files?.[0]; if (!f) { resolve(null); return; }
      try {
        const bmp = await createImageBitmap(f);
        const side = Math.min(bmp.width, bmp.height);
        const c = document.createElement('canvas'); c.width = c.height = 128;
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 128, 128);
        g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 128, 128);
        let q = 0.85, url = c.toDataURL('image/jpeg', q);
        while (url.length > 55000 && q > 0.3) { q -= 0.15; url = c.toDataURL('image/jpeg', q); }
        resolve(url);
      } catch { ctx.toast('그림을 읽지 못했습니다'); resolve(null); }
    });
    inp.click();
  });
}
const avatarHtml = (u, size = 44) => (u.avatar
  ? `<img class="av" src="${esc(u.avatar)}" width="${size}" height="${size}" alt="">`
  : `<span class="av" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px">${esc((u.name || u.email || '?').replace(/^@/, '').slice(0, 1).toUpperCase())}</span>`);

// 계정 (로그인·프로필·비밀번호·탈퇴)
export async function accountDialog() {
  if (!auth) { if (await login()) accountDialog(); return; }
  await refreshMe();
  if (!auth) { accountDialog(); return; }
  const u = auth.user; const isId = u.kind === 'id';
  const body = el(`<div class="me"><div class="who">${avatarHtml(u)}<div><b>${esc(u.name || '')}</b><br><small>${esc(u.email)} · ${isId ? '아이디 회원' : 'Google 계정'}</small></div></div><button class="btn sub" data-out>로그아웃</button></div>
    <div class="sec"><div class="t">프로필</div>
      <div class="r"><input data-nick maxlength="20" placeholder="이름(별명)" value="${esc(u.name || '')}"><button class="btn sub" data-savenick>이름 바꾸기</button></div>
      <div class="r" style="margin-top:6px"><button class="btn sub" data-photo>사진 고르기</button>${u.avatar ? '<button class="btn sub" data-nophoto>사진 빼기</button>' : ''}</div></div>
    ${isId ? `<div class="sec"><div class="t">비밀번호·복구 코드</div>
      <div class="r"><button class="btn sub" data-pw>비밀번호 바꾸기</button><button class="btn sub" data-code>복구 코드 새로 받기</button></div></div>` : ''}
    <div class="sec"><div class="t">내 문서함 <small>${vaultOn ? '켜짐' : '꺼짐'}</small></div>
      <div class="r"><div style="flex:1;color:#4a5363;font-size:12.5px">${vaultOn
        ? '어느 PC에서나 로그인하면 내 클라우드 문서 목록이 보입니다. 문서 열쇠는 서버 비밀키로 다시 잠가 보관하므로 저장소가 유출돼도 읽을 수 없지만, 서버 자체가 뚫리면 열릴 수 있습니다(한컴독스·구글 문서와 같은 수준).'
        : '꺼져 있어 문서 열쇠는 링크 안에만 있습니다. 서버도 문서를 열 수 없는 최고 보안이지만, 링크를 잃어버리면 다시 열 수 없습니다.'}</div>
      <button class="btn sub" data-vault>${vaultOn ? '끄기' : '켜기'}</button></div></div>
    <div class="note">로그인은 30일 동안 유지됩니다. 공용 PC라면 다 쓴 뒤 꼭 로그아웃해 주세요.
      <div class="links" style="margin-top:6px"><button class="lnk" data-terms>이용약관</button><button class="lnk" data-privacy>개인정보처리방침</button><button class="lnk danger" data-leave>회원 탈퇴</button></div></div>`);
  const d = dialog('클라우드 계정', body);
  d.querySelector('[data-out]').addEventListener('click', async () => { d.close(); await logout(); });
  d.querySelector('[data-terms]').addEventListener('click', () => window.open(termsUrl(), '_blank'));
  d.querySelector('[data-privacy]').addEventListener('click', () => window.open(privacyUrl(), '_blank'));
  const putProfile = async (data, msg) => {
    const res = await call('/api/account/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const r = await jsonOf(res);
    if (!res.ok) { ctx.toast(r.message || '바꾸지 못했습니다'); return; }
    await refreshMe(); ctx.toast(msg); d.close(); accountDialog();
  };
  d.querySelector('[data-savenick]').addEventListener('click', () => {
    const n = d.querySelector('[data-nick]').value.trim();
    if (!n) { ctx.toast('이름을 넣어 주세요'); return; }
    putProfile({ nick: n }, '이름을 바꿨습니다');
  });
  d.querySelector('[data-photo]').addEventListener('click', async () => { const a = await pickAvatar(); if (a) putProfile({ avatar: a }, '사진을 바꿨습니다'); });
  d.querySelector('[data-nophoto]')?.addEventListener('click', () => putProfile({ avatar: null }, '사진을 뺐습니다'));
  d.querySelector('[data-pw]')?.addEventListener('click', () => { d.close(); passwordDialog(); });
  d.querySelector('[data-code]')?.addEventListener('click', () => { d.close(); newCodeDialog(); });
  d.querySelector('[data-leave]').addEventListener('click', () => { d.close(); withdrawDialog(); });
  d.querySelector('[data-vault]').addEventListener('click', async () => {
    if (vaultOn && !confirm('내 문서함을 끄면 보관한 열쇠를 모두 지웁니다.\n다른 PC에서는 링크로만 열 수 있게 됩니다. 끌까요?')) return;
    if (await setVault(!vaultOn)) { d.close(); accountDialog(); }
  });
}

function formDialog(title, html, run) {
  const d = dialog(title, el(`${html}<div class="err" data-err></div><button class="btn wide" data-go>${title}</button>`));
  const go = d.querySelector('[data-go]'); const err = d.querySelector('[data-err]');
  const fire = async () => {
    if (go.disabled) return;
    err.textContent = ''; go.disabled = true;
    try { const m = await run(d); if (m) err.textContent = m; } catch (e) { err.textContent = e.message || '잠시 뒤에 다시 해 주세요'; } finally { go.disabled = false; }
  };
  go.addEventListener('click', fire);
  d.querySelectorAll('input:not([type=checkbox])').forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fire(); } }));
  d.querySelector('input')?.focus();
  return d;
}
const pwOk = (p) => p.length >= 8 && /[A-Za-z]/.test(p) && /[0-9]/.test(p);
function passwordDialog() {
  formDialog('비밀번호 바꾸기', `<label class="f">지금 비밀번호<input data-o type="password" autocomplete="current-password"></label>
    <label class="f">새 비밀번호 <small>8자 이상, 영문과 숫자를 함께</small><input data-p type="password" autocomplete="new-password"></label>
    <label class="f">새 비밀번호 확인<input data-p2 type="password" autocomplete="new-password"></label>
    <div class="note">바꾸면 다른 PC·브라우저의 로그인은 모두 끊기고, 이 화면만 로그인된 채로 남습니다.</div>`, async (d) => {
    const old = d.querySelector('[data-o]').value; const password = d.querySelector('[data-p]').value;
    if (!pwOk(password)) return '새 비밀번호는 8자 이상, 영문과 숫자를 함께 넣어 주세요';
    if (password !== d.querySelector('[data-p2]').value) return '새 비밀번호 확인이 맞지 않습니다';
    const res = await call('/api/account/password', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ old, password }) });
    const r = await jsonOf(res);
    if (!res.ok) return r.message || '바꾸지 못했습니다';
    saveAuth({ ...auth, token: r.token });
    d.close(); ctx.toast('비밀번호를 바꿨습니다. 다른 기기의 로그인은 끊겼습니다');
    return null;
  });
}
function newCodeDialog() {
  formDialog('복구 코드 새로 받기', `<div>예전 복구 코드는 더는 쓸 수 없게 되고 새 코드가 나옵니다. 본인 확인을 위해 비밀번호를 넣어 주세요.</div>
    <label class="f" style="margin-top:8px">비밀번호<input data-p type="password" autocomplete="current-password"></label>`, async (d) => {
    const { res, r } = await postJson('/api/account/recovery', { password: d.querySelector('[data-p]').value });
    if (!res.ok) return r.message || '받지 못했습니다';
    d.close(); await recoveryCodeDialog(r.recovery, '새 복구 코드를 만들었습니다');
    return null;
  });
}
function withdrawDialog() {
  const isId = auth?.user?.kind === 'id';
  formDialog('회원 탈퇴', `<div><b>${esc(auth.user.email)}</b> 계정을 탈퇴합니다. 되돌릴 수 없어요.</div>
    <ul class="warn">
      <li>내가 <b>주인인 클라우드 문서</b>가 모든 버전과 함께 지워지고, 공유한 링크로도 더는 열 수 없습니다.</li>
      <li>내 문서함·프로필${isId ? '·비밀번호·복구 코드' : ''}가 지워지고 모든 기기에서 로그아웃됩니다.</li>
      ${isId ? '<li>이 아이디는 다른 사람이 옛 문서 권한을 얻지 못하도록 <b>다시 쓸 수 없습니다</b>.</li>' : '<li>나중에 같은 Google 계정으로 다시 로그인하면 빈 계정으로 새로 시작합니다.</li>'}
      <li>필요한 문서는 먼저 내 PC에 저장해 두세요. 내 PC의 파일은 지워지지 않습니다.</li>
    </ul>
    ${isId ? '<label class="f">비밀번호<input data-p type="password" autocomplete="current-password"></label>' : ''}
    <label class="ck"><input type="checkbox" data-ok> 위 내용을 확인했고 탈퇴합니다</label>`, async (d) => {
    if (!d.querySelector('[data-ok]').checked) return '확인란을 눌러 주세요';
    const res = await call('/api/account', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true, password: d.querySelector('[data-p]')?.value || '' }) });
    const r = await jsonOf(res);
    if (!res.ok) return r.message || '탈퇴하지 못했습니다';
    d.close();
    if (s) { s.leaving = true; clearInterval(s.ping); clearInterval(s.beat); try { s.ws?.close(); } catch { /* 무시 */ } s = null; setHash(); refreshBar(); }
    saveAuth(null); vaultOn = true;
    ctx.toast(`탈퇴했습니다${r.removed ? ` (클라우드 문서 ${r.removed}개를 지웠습니다)` : ''}. 그동안 써 주셔서 고맙습니다`);
    return null;
  });
}

export async function shareDialog() {
  if (!s) { ctx.toast('먼저 "클라우드에 저장"을 눌러 문서를 올려 주세요'); return; }
  let editors = null;
  if (s.isOwner) { try { editors = (await jsonOf(await call(`/api/docs/${s.id}`))).editors || []; } catch { editors = []; } }
  const body = el(`
    <div class="sec"><div class="t">문서 링크<small>링크가 있으면 누구나 볼 수 있어요</small></div>
      <div class="r"><input readonly value="${esc(linkOf())}"><button class="btn" data-copy>복사</button></div></div>
    ${editors ? `<div class="sec"><div class="t">고칠 수 있는 사람<small>회원 아이디 또는 Google 이메일 · 로그인해야 고칠 수 있어요</small></div>
      <div class="chips"><span class="chip" style="background:#e6f4ec">${esc(auth.user.email)} (주인)</span></div>
      <div class="r" style="margin-top:8px"><input placeholder="아이디(예: hong123) 또는 Google 이메일" data-email autocapitalize="off" spellcheck="false"><button class="btn sub" data-add>추가</button></div></div>` : `
      <div class="sec"><div class="t">고치기</div>${s.canEdit ? '이 문서를 고칠 수 있어요.' : `고치려면 문서 주인이 내 ${auth?.user?.kind === 'id' ? `아이디(${esc(auth.user.email.slice(1))})` : '이메일'}를 추가해야 해요.`}</div>`}
    <div class="note">🔒 문서는 이 PC에서 잠가서 올립니다. ${vaultOn && auth
      ? '열쇠는 링크와 <b>내 문서함</b>(서버 비밀키로 다시 잠가 보관)에 있어, 어느 PC에서나 "내 문서"에서 다시 열 수 있어요.'
      : '열쇠는 링크의 <b>#</b> 뒤에만 있어 서버도 내용을 볼 수 없어요. 링크를 잃어버리면 다시 열 수 없으니 잘 보관하세요.'}</div>`);
  const d = dialog('공유', body);
  d.querySelector('[data-copy]').addEventListener('click', () => copy(linkOf()));
  d.querySelector('input[readonly]').addEventListener('focus', (e) => e.target.select());
  if (!editors) return;
  const chips = d.querySelector('.chips');
  const owner = chips.firstElementChild;
  const render = () => {
    chips.replaceChildren(owner);
    for (const e of editors) {
      const c = document.createElement('span'); c.className = 'chip'; c.textContent = e;
      const x = document.createElement('button'); x.textContent = '✕'; x.title = '빼기';
      x.addEventListener('click', () => update(editors.filter((v) => v !== e)));
      c.append(x); chips.append(c);
    }
  };
  const update = async (list) => {
    const res = await call(`/api/docs/${s.id}/editors`, { method: 'PUT', body: JSON.stringify({ editors: list }) });
    const r = await jsonOf(res);
    if (!res.ok) { ctx.toast(r.message || '바꾸지 못했습니다'); return; }
    editors = r.editors; render();
  };
  render();
  const input = d.querySelector('[data-email]');
  const add = () => {
    let v = input.value.trim().toLowerCase();
    if (/^@?[a-z][a-z0-9_]{3,19}$/.test(v)) v = v.startsWith('@') ? v : `@${v}`; // 회원 아이디
    else if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v)) { ctx.toast('회원 아이디나 이메일 주소를 확인해 주세요'); return; }
    if (v === auth.user.email) { ctx.toast('나는 이미 주인입니다'); return; }
    input.value = '';
    update([...new Set([...editors, v])]);
  };
  d.querySelector('[data-add]').addEventListener('click', add);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
}

export async function versionsDialog() {
  if (!s) { ctx.toast('클라우드 문서가 아닙니다'); return; }
  let info;
  try { info = await jsonOf(await call(`/api/docs/${s.id}`)); } catch (e) { ctx.toast(e.message); return; }
  const rows = [];
  for (const v of [...(info.versions || [])].reverse()) {
    const by = await openText(s.key, v.by);
    const at = new Date(v.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    rows.push(`<tr><td>${v.n}${v.n === s.openedN ? ' <small style="color:#2f6fd6">(보는 중)</small>' : ''}</td><td>${esc(at)}</td><td>${esc(by)}</td><td>${(v.size / 1048576).toFixed(1)}MB</td>
      <td class="acts"><button class="btn sub" data-open="${v.n}">열기</button>${s.canEdit ? ` <button class="btn sub" data-restore="${v.n}">되돌리기</button>` : ''}</td></tr>`);
  }
  const body = el(`<div>저장할 때마다 버전이 남습니다 (최근 20개).</div>
    <div class="list"><table><tr><th>버전</th><th>저장 시각</th><th>저장한 사람</th><th>크기</th><th></th></tr>${rows.join('')}</table></div>`);
  const d = dialog('버전 기록', body);
  d.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', async () => { d.close(); await loadVersion(Number(b.dataset.open)); refreshBar(); }));
  d.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', async () => {
    const n = Number(b.dataset.restore);
    if (!confirm(`버전 ${n}을 최신 버전으로 되돌릴까요? (지금 버전도 기록에 남습니다)`)) return;
    d.close();
    await restoreVersion(n);
  }));
}

/* ---------- 열기 ---------- */
async function fetchVersion(n) {
  const res = await call(`/api/docs/${s.id}/v/${n}`);
  if (!res.ok) throw new Error('문서 파일을 받지 못했습니다');
  try { return await unpackDoc(s.key, await res.arrayBuffer()); }
  catch { throw new Error('열쇠가 맞지 않습니다. 링크를 끝까지 정확히 복사했는지 확인해 주세요'); }
}
async function loadVersion(n) {
  const doc = await fetchVersion(n);
  s.opening = true;
  try { await ctx.openBytes(doc.bytes, doc.name); } finally { s.opening = false; }
  s.openedN = n; s.name = doc.name; s.format = doc.format;
  ctx.toast(`클라우드 문서를 열었습니다 (버전 ${n})`);
}
async function refreshRights() {
  if (!s) return;
  const info = await jsonOf(await call(`/api/docs/${s.id}`));
  s.canEdit = !!info.you?.canEdit; s.isOwner = !!info.you?.isOwner;
  s.lockBy = info.lock ? await openText(s.key, info.lock.by) : null;
  s.lockMine = !!info.lock?.mine;
  addToMyDocs();
  if (s.canEdit && !info.lock && !s.editing) { await startEditing(true); return; }
  refreshBar();
  // 보던 것보다 새 버전이 있으면 알린다 (로그인하는 사이 저장된 경우)
  const last = info.versions?.[info.versions.length - 1];
  if (last && last.n > s.openedN && !s.editing) {
    const by = await openText(s.key, last.by);
    showBar(`${by}님이 새 버전(${last.n})을 저장했습니다`, { buttons: [{ label: '불러오기', primary: true, run: async () => { await loadVersion(last.n); refreshBar(); } }, { label: '나중에', run: () => refreshBar() }] });
  }
}

export async function openLink(text) {
  const p = parseLink(text);
  if (!p) { ctx.toast('클라우드 링크가 아닙니다'); return false; }
  await leave();
  ctx.toast('클라우드에서 문서를 받는 중…');
  try {
    s = { id: p.id, keyStr: p.keyStr, key: await importKey(p.keyStr), lockId: null, editing: false, lockBy: null, openedN: 0, canEdit: false, isOwner: false };
    const res = await call(`/api/docs/${s.id}`);
    if (res.status === 404) throw new Error('지워졌거나 없는 문서입니다');
    const info = await jsonOf(res);
    const last = info.versions?.[info.versions.length - 1];
    if (!last) throw new Error('아직 저장된 내용이 없는 문서입니다');
    await loadVersion(last.n);
    s.canEdit = !!info.you?.canEdit; s.isOwner = !!info.you?.isOwner;
    s.lockBy = info.lock ? await openText(s.key, info.lock.by) : null;
    s.lockMine = !!info.lock?.mine;
    connectLive();
    if (s.canEdit && !info.lock) await startEditing(false);
    setHash();
    refreshBar();
    addToMyDocs();
    return true;
  } catch (e) {
    console.error(e);
    ctx.toast(e.message || '클라우드 문서를 열지 못했습니다');
    s = null; refreshBar();
    return false;
  }
}
export async function openFromClipboard() {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch { /* 무시 */ }
  if (parseLink(text)) return openLink(text);
  const body = el(`<div>받은 클라우드 링크를 복사한 뒤 아래 단추를 누르세요.</div>
    <div class="sec"><div class="r"><input placeholder="https://…#cloud=…"><button class="btn">열기</button></div></div>`);
  const d = dialog('클라우드 링크로 열기', body);
  const input = d.querySelector('input');
  d.querySelector('.btn').addEventListener('click', async () => {
    let t = input.value;
    if (!parseLink(t)) { try { t = await navigator.clipboard.readText(); } catch { /* 무시 */ } }
    if (!parseLink(t)) { ctx.toast('클라우드 링크를 찾지 못했습니다'); return; }
    d.close(); openLink(t);
  });
  return false;
}

/* ---------- 편집 잠금 ---------- */
async function startEditing(reloadLatest, takeover = false) {
  if (!s?.canEdit) return false;
  try {
    if (reloadLatest) {
      const info = await jsonOf(await call(`/api/docs/${s.id}`));
      const last = info.versions?.[info.versions.length - 1];
      if (last && last.n !== s.openedN) await loadVersion(last.n);
    }
    const res = await call(`/api/docs/${s.id}/lock`, { method: 'POST', body: JSON.stringify({ by: await sealText(s.key, myName()), takeover }) });
    const r = await jsonOf(res);
    if (res.status === 409) { s.lockBy = await openText(s.key, r.lock?.by); s.lockMine = !!r.lock?.mine; s.editing = false; refreshBar(); return false; }
    if (res.status === 401 || res.status === 403) { s.canEdit = false; refreshBar(); ctx.toast(r.message || '고칠 권한이 없습니다'); return false; }
    if (!res.ok) throw new Error('편집 권한을 받지 못했습니다');
    s.lockId = r.lockId; s.editing = true; s.lockBy = null; s.lockMine = false;
    clearInterval(s.beat);
    s.beat = setInterval(() => renewLock().catch(() => {}), HEARTBEAT);
    refreshBar();
    return true;
  } catch (e) { ctx.toast(e.message); return false; }
}
async function renewLock() {
  if (!s?.editing) return;
  const res = await call(`/api/docs/${s.id}/lock`, { method: 'POST', body: JSON.stringify({ by: await sealText(s.key, myName()), lockId: s.lockId }) });
  if (res.status === 409 || res.status === 401 || res.status === 403) {
    const r = await jsonOf(res);
    s.editing = false; s.lockId = null; clearInterval(s.beat);
    s.lockBy = r.lock ? await openText(s.key, r.lock.by) : null;
    refreshBar();
    showBar(res.status === 409
      ? (r.lock?.mine ? '다른 PC(또는 창)에서 편집을 넘겨받았습니다. 여기서 고친 내용은 다른 이름으로 따로 저장해 주세요' : `연결이 끊긴 사이 ${s.lockBy}님이 편집을 시작했습니다. 내 변경은 다른 이름으로 따로 저장해 주세요`)
      : '로그인이 끝나 편집이 멈췄습니다. 다시 로그인해 주세요', { ro: true, warn: true, buttons: res.status === 409 ? [] : [{ label: '로그인', primary: true, run: () => login() }] });
  }
}
async function releaseLock() {
  if (!s?.editing) return;
  clearInterval(s.beat);
  s.editing = false;
  try { await call(`/api/docs/${s.id}/lock`, { method: 'DELETE', lock: true, keepalive: true }); } catch { /* 무시 */ }
  s.lockId = null;
}

/* ---------- 실시간 알림 ---------- */
function connectLive() {
  if (!s || !API) return;
  const my = s;
  const ws = new WebSocket(`${API.replace(/^http/, 'ws')}/api/docs/${s.id}/live`);
  my.ws = ws;
  ws.onmessage = async (e) => {
    if (s !== my || e.data === 'pong') return;
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'version') {
      if (my.editing || m.n <= my.openedN || m.n === my.mySaved) return;
      const by = await openText(my.key, m.by);
      showBar(`${by}님이 새 버전(${m.n})을 저장했습니다`, { buttons: [{ label: '불러오기', primary: true, run: async () => { await loadVersion(m.n); refreshBar(); } }, { label: '나중에', run: () => refreshBar() }] });
    } else if (m.type === 'lock') {
      if (my.editing) { if (m.lock) renewLock().catch(() => {}); return; }
      my.lockBy = m.lock ? await openText(my.key, m.lock.by) : null;
      if (m.lock && my.canEdit) { try { const i2 = await jsonOf(await call(`/api/docs/${my.id}`)); my.lockMine = !!i2.lock?.mine; } catch { /* 무시 */ } } else my.lockMine = false;
      refreshBar();
      if (!m.lock && my.canEdit) {
        showBar('이제 편집할 수 있어요', { buttons: [{ label: '최신 버전 불러와 편집', primary: true, run: () => startEditing(true) }, { label: '나중에', run: () => refreshBar() }] });
      }
    } else if (m.type === 'deleted') {
      showBar('이 클라우드 문서는 주인이 지웠습니다', { warn: true });
    }
  };
  ws.onclose = () => { if (s === my && !my.leaving) setTimeout(() => { if (s === my) connectLive(); }, 5000); };
  clearInterval(my.ping);
  my.ping = setInterval(() => { try { ws.send('ping'); } catch { /* 무시 */ } }, 25000);
}

/* ---------- 내 문서함 ---------- */
let vaultOn = true; // 서버 설정을 받아 오기 전까지는 켜짐으로 본다
const ROLE_KO = { owner: '주인', editor: '편집', viewer: '보기' };
async function addToMyDocs() {
  if (!auth || !s || !vaultOn) return;
  const role = s.isOwner ? 'owner' : s.canEdit ? 'editor' : 'viewer';
  const nm = s.name || '';
  const format = s.format || (/\.docx$/i.test(nm) ? 'docx' : /\.hwpx$/i.test(nm) ? 'hwpx' : 'hwp');
  try {
    const res = await call(`/api/mydocs/${s.id}`, { method: 'PUT', body: JSON.stringify({ key: s.keyStr, name: nm || '이름 없음', format, role }) });
    if (res.status === 409) { const r2 = await jsonOf(res); if (r2.error === 'disabled') vaultOn = false; }
  } catch { /* 다음에 다시 */ }
}

export async function myDocsDialog() {
  if (!auth) { if (!(await login())) return; }
  let st;
  try { st = await jsonOf(await call('/api/mydocs')); } catch (e) { ctx.toast(e.message); return; }
  if (!Array.isArray(st.docs)) { ctx.toast('내 문서를 불러오지 못했습니다'); return; }
  vaultOn = st.enabled !== false;
  const when = (x) => new Date(x).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const rows = st.docs.map((d) => `<tr><td>${esc(d.name)}</td><td>${esc(d.format.toUpperCase())}</td><td>${ROLE_KO[d.role] || ''}</td><td>${esc(when(d.opened))}</td>
    <td class="acts"><button class="btn" data-open="${d.id}">열기</button> <button class="btn sub" data-drop="${d.id}" title="목록에서만 빼기 (문서는 그대로)">빼기</button>${d.role === 'owner' ? ` <button class="btn sub" data-del="${d.id}" title="클라우드에서 문서를 완전히 지우기">지우기</button>` : ''}</td></tr>`).join('');
  const empty = '<tr><td colspan="5" style="color:#5b6575;padding:18px 6px">아직 없습니다. "클라우드에 저장"을 누르거나 받은 링크를 열면 여기에 쌓입니다.</td></tr>';
  const body = el(vaultOn ? `<div>${esc(auth.user.email)} 계정의 클라우드 문서입니다. 어느 PC에서나 로그인하면 보입니다.</div>
    <div class="list"><table><tr><th>이름</th><th>종류</th><th>내 역할</th><th>최근</th><th></th></tr>${rows || empty}</table></div>`
    : '<div>내 문서함이 꺼져 있습니다. 클라우드 문서는 링크로만 열 수 있습니다.</div><div class="sec"><button class="btn" data-on>내 문서함 켜기</button></div>');
  const d = dialog('내 클라우드 문서', body);
  const find = (id) => st.docs.find((x) => x.id === id);
  d.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => { const x = find(b.dataset.open); d.close(); openLink(`#cloud=${x.id}.${x.key}`); }));
  d.querySelectorAll('[data-drop]').forEach((b) => b.addEventListener('click', async () => {
    await call(`/api/mydocs/${b.dataset.drop}`, { method: 'DELETE' }); d.close(); myDocsDialog();
  }));
  d.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const x = find(b.dataset.del);
    if (!confirm(`"${x.name}" 문서를 클라우드에서 완전히 지울까요?\n모든 버전이 지워지고, 공유한 링크로도 더는 열 수 없습니다. 되돌릴 수 없습니다.`)) return;
    const res = await call(`/api/docs/${x.id}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) { ctx.toast((await jsonOf(res)).message || '지우지 못했습니다'); return; }
    await call(`/api/mydocs/${x.id}`, { method: 'DELETE' });
    if (s && s.id === x.id) await leave();
    ctx.toast('문서를 지웠습니다'); d.close(); myDocsDialog();
  }));
  const on = d.querySelector('[data-on]');
  if (on) on.addEventListener('click', async () => { await setVault(true); d.close(); myDocsDialog(); });
}
async function setVault(on) {
  const res = await call('/api/mydocs/settings', { method: 'PUT', body: JSON.stringify({ enabled: on }) });
  if (!res.ok) { ctx.toast('바꾸지 못했습니다'); return false; }
  vaultOn = on;
  if (on) await addToMyDocs();
  ctx.toast(on ? '내 문서함을 켰습니다' : '내 문서함을 끄고 보관한 열쇠를 모두 지웠습니다');
  return true;
}

/* ---------- 저장 ---------- */
let saving = false;
export async function saveToCloud() {
  if (saving) return;
  if (!API) { ctx.toast('클라우드 서버가 아직 준비되지 않았습니다'); return; }
  if (!auth && !(await login())) return;
  saving = true;
  try {
    if (s && !s.canEdit) await refreshRights();
    if (s && !s.canEdit) { ctx.toast('이 문서를 고칠 권한이 없습니다. 문서 주인에게 요청해 주세요'); return; }
    if (s && !s.editing && !(await startEditing(false))) {
      ctx.toast(s.lockBy ? `${s.lockBy}님이 편집 중이라 저장할 수 없습니다` : '편집 권한을 받지 못했습니다');
      return;
    }
    ctx.toast('클라우드에 올리는 중…');
    const docNow = await ctx.getDoc(); // { bytes, name, format }
    let fresh = false;
    if (!s) {
      const res = await call('/api/docs', { method: 'POST' });
      const r = await jsonOf(res);
      if (res.status === 401) { saving = false; if (await login()) return saveToCloud(); return; }
      if (!res.ok) throw new Error(r.message || '클라우드 문서를 만들지 못했습니다');
      const k = await newKey();
      s = { id: r.id, key: k.key, keyStr: k.str, lockId: null, editing: false, lockBy: null, openedN: 0, canEdit: true, isOwner: true };
      if (!(await startEditing(false))) throw new Error('편집 권한을 받지 못했습니다');
      connectLive();
      fresh = true;
    } else {
      // 내가 연 뒤에 다른 사람이 저장했다면 알려 준다 (이전 버전은 기록에 남는다)
      const info = await jsonOf(await call(`/api/docs/${s.id}`));
      const last = info.versions?.[info.versions.length - 1];
      if (last && s.openedN && last.n > s.openedN && last.n !== s.mySaved
        && !confirm(`이 문서를 연 뒤에 다른 사람이 새 버전(${last.n})을 저장했습니다.\n내 내용으로 저장할까요? (그 버전도 기록에 남습니다)`)) return;
    }
    const res = await call(`/api/docs/${s.id}`, { method: 'PUT', lock: true, headers: { 'X-Author': await sealText(s.key, myName()) }, body: await packDoc(s.key, docNow) });
    const r = await jsonOf(res);
    if (res.status === 409) { s.editing = false; s.lockBy = await openText(s.key, r.lock?.by); refreshBar(); throw new Error(`${s.lockBy}님이 편집 중이라 저장하지 못했습니다`); }
    if (!res.ok) throw new Error(r.message || '클라우드에 저장하지 못했습니다');
    s.openedN = r.n; s.mySaved = r.n; s.name = docNow.name; s.format = docNow.format;
    s.savedAt = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    await ctx.markSaved?.();
    setHash();
    refreshBar();
    ctx.toast(`클라우드에 저장했습니다 (버전 ${r.n})`);
    addToMyDocs();
    if (fresh) shareDialog();
  } catch (e) {
    console.error(e);
    ctx.toast(e.message || '클라우드에 저장하지 못했습니다');
  } finally { saving = false; }
}

async function restoreVersion(n) {
  try {
    const old = await fetchVersion(n);
    if (!s.editing && !(await startEditing(false))) { ctx.toast(s.lockBy ? `${s.lockBy}님이 편집 중이라 되돌릴 수 없습니다` : '고칠 권한이 없습니다'); return; }
    const res = await call(`/api/docs/${s.id}`, { method: 'PUT', lock: true, headers: { 'X-Author': await sealText(s.key, myName()) }, body: await packDoc(s.key, old) });
    const r = await jsonOf(res);
    if (!res.ok) throw new Error(r.message || '되돌리지 못했습니다');
    s.mySaved = r.n;
    await loadVersion(r.n);
    refreshBar();
    ctx.toast(`버전 ${n}의 내용을 새 버전(${r.n})으로 되돌렸습니다`);
  } catch (e) { ctx.toast(e.message); }
}

/* ---------- 정리 ---------- */
export async function leave() {
  if (!s || s.opening) return;
  const my = s;
  my.leaving = true;
  await releaseLock();
  clearInterval(my.ping);
  try { my.ws?.close(); } catch { /* 무시 */ }
  s = null;
  setHash();
  refreshBar();
}
function setHash() {
  if (ctx?.desktop) return; // 설치형은 주소 줄이 없다
  const want = s ? `#cloud=${s.id}.${s.keyStr}` : '';
  if (location.hash !== want) history.replaceState(null, '', want || location.pathname + location.search);
}

export const isCloud = () => !!s;
export const available = () => !!API;

export function initCloud(context) {
  ctx = context;
  loadAuth();
  window.addEventListener('pagehide', () => {
    if (s?.editing) { try { fetch(`${API}/api/docs/${s.id}/lock`, { method: 'DELETE', headers: { 'X-Lock-Id': s.lockId, ...(auth ? { Authorization: `Bearer ${auth.token}` } : {}) }, keepalive: true }); } catch { /* 무시 */ } }
  });
  if (!ctx.desktop && parseLink(location.hash)) setTimeout(() => openLink(location.hash), 300);
  window.addEventListener('hashchange', () => {
    const p = parseLink(location.hash);
    if (p && (!s || p.id !== s.id)) openLink(location.hash);
  });
}
