// 한글 편집기 클라우드 (서버: cloud/src/index.js)
// - 문서는 이 PC에서 AES-GCM으로 잠근 뒤 올린다. 열쇠는 공유 링크의 # 뒤에만 있어 서버는 내용·파일 이름·작성자를 볼 수 없다.
// - 링크: <웹판>#cloud=<문서id>.<열쇠>          보기 전용
//         <웹판>#cloud=<문서id>.<열쇠>.<고치기표식>  고치기 가능
// - 한 번에 한 사람만 고친다(편집 잠금, 30초마다 연장). 저장할 때마다 버전이 쌓이고, 보는 사람에게 알림이 간다.

const WEB_URL = 'https://sion-dev404.github.io/hangul-editor/';
// 배포한 서버 주소 (wrangler deploy 뒤에 적는다). 개발 서버(5173·5198·5199)에서는 로컬 서버(wrangler dev)를 쓴다.
const PROD_API = '';
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

/* ---------- 서버 ---------- */
async function call(path, opt = {}) {
  if (!API) throw new Error('클라우드 서버가 아직 준비되지 않았습니다');
  const headers = { ...(opt.headers || {}) };
  if (s?.editToken && opt.edit) headers['X-Edit-Token'] = s.editToken;
  if (s?.lockId && opt.lock) headers['X-Lock-Id'] = s.lockId;
  let res;
  try { res = await fetch(API + path, { method: opt.method || 'GET', headers, body: opt.body, keepalive: opt.keepalive }); }
  catch { throw new Error('클라우드에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요'); }
  return res;
}
const jsonOf = async (res) => { try { return await res.json(); } catch { return {}; } };

/* ---------- 이름 ---------- */
const NAME_KEY = 'hangul-editor-cloud-name';
function myName() {
  try { const n = localStorage.getItem(NAME_KEY); if (n) return n; } catch { /* 무시 */ }
  const n = ctx?.desktop?.userName || `사용자 ${Math.floor(1000 + Math.random() * 9000)}`;
  try { localStorage.setItem(NAME_KEY, n); } catch { /* 무시 */ }
  return n;
}
function setMyName(n) { try { localStorage.setItem(NAME_KEY, n.trim().slice(0, 30) || myName()); } catch { /* 무시 */ } }

/* ---------- 링크 ---------- */
export function linkOf(withEdit) {
  if (!s) return '';
  return `${WEB_URL}#cloud=${s.id}.${s.keyStr}${withEdit && s.editToken ? `.${s.editToken}` : ''}`;
}
export function parseLink(text) {
  const m = /#cloud=([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})(?:\.([A-Za-z0-9_-]{32}))?/.exec(String(text || ''));
  return m ? { id: m[1], keyStr: m[2], editToken: m[3] || null } : null;
}

/* ---------- 상태 표시 줄 ---------- */
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
#cloudDlg .lk{margin:12px 0 0}
#cloudDlg .lk .t{font-weight:700;margin-bottom:4px}
#cloudDlg .lk .t small{font-weight:400;color:#5b6575;margin-left:6px}
#cloudDlg .lk .r{display:flex;gap:6px}
#cloudDlg .lk input{flex:1;min-width:0;border:1px solid #d5dbe4;border-radius:8px;padding:8px 10px;font:12px Consolas,monospace;color:#3a4352;background:#f7f8fa}
#cloudDlg .btn{border:0;border-radius:8px;padding:8px 14px;font:inherit;font-weight:700;cursor:pointer;background:#2f6fd6;color:#fff;white-space:nowrap}
#cloudDlg .btn.sub{background:#e8f0fc;color:#2f6fd6}
#cloudDlg .note{margin-top:14px;background:#f3f5f8;border-radius:8px;padding:10px 12px;color:#4a5363;font-size:12.5px}
#cloudDlg .me{display:flex;align-items:center;gap:8px;margin-top:14px}
#cloudDlg .me input{border:1px solid #d5dbe4;border-radius:8px;padding:6px 10px;font:inherit;width:160px}
#cloudDlg table{width:100%;border-collapse:collapse;margin-top:6px}
#cloudDlg td,#cloudDlg th{padding:7px 6px;border-bottom:1px solid #e6e9ee;text-align:left}
#cloudDlg th{font-size:12px;color:#5b6575;font-weight:700}
#cloudDlg td.acts{text-align:right;white-space:nowrap}
#cloudDlg td.acts .btn{padding:5px 10px;font-size:12px}
#cloudDlg .list{max-height:min(50vh,380px);overflow:auto}
`;
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
  } else if (s.lockBy) {
    showBar(`${s.lockBy}님이 편집 중입니다 · 지금은 보기만 할 수 있어요`, { ro: true, buttons: [{ label: '버전 기록', run: () => versionsDialog() }] });
  } else if (s.editToken) {
    showBar('클라우드 문서 · 지금 아무도 편집하지 않아요', { ro: true, buttons: [{ label: '편집 시작', primary: true, run: () => startEditing(true) }] });
  } else {
    showBar('클라우드 문서 · 보기 전용 링크', { ro: true, buttons: [{ label: '버전 기록', run: () => versionsDialog() }] });
  }
}

/* ---------- 대화 상자 ---------- */
function dialog(title, body) {
  ensureUi();
  document.getElementById('cloudDlg')?.remove();
  const d = document.createElement('dialog'); d.id = 'cloudDlg';
  d.innerHTML = `<div class="hd"><b></b><button class="x" title="닫기">✕</button></div><div class="bd"></div>`;
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

export function shareDialog() {
  if (!s) { ctx.toast('먼저 "클라우드에 저장"을 눌러 문서를 올려 주세요'); return; }
  const body = el(`
    <div>문서를 함께 볼 사람에게 링크를 보내 주세요. 링크를 가진 사람만 열 수 있습니다.</div>
    ${s.editToken ? `<div class="lk"><div class="t">고치기 링크<small>받은 사람도 고칠 수 있어요 (한 번에 한 명)</small></div>
      <div class="r"><input readonly value="${esc(linkOf(true))}"><button class="btn" data-c="1">복사</button></div></div>` : ''}
    <div class="lk"><div class="t">보기 링크<small>읽기만 할 수 있어요</small></div>
      <div class="r"><input readonly value="${esc(linkOf(false))}"><button class="btn sub" data-c="0">복사</button></div></div>
    <div class="me">내 이름 <input value="${esc(myName())}" maxlength="30"> <small style="color:#5b6575">편집 중 표시에 쓰여요</small></div>
    <div class="note">🔒 문서는 이 PC에서 잠가서 올립니다. 링크의 <b>#</b> 뒤가 열쇠라 서버도 내용을 볼 수 없어요. 링크를 잃어버리면 다시 열 수 없으니 잘 보관하세요.</div>`);
  const d = dialog('공유 링크', body);
  d.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', () => copy(linkOf(b.dataset.c === '1'))));
  d.querySelectorAll('.lk input').forEach((i) => i.addEventListener('focus', () => i.select()));
  const nameIn = d.querySelector('.me input');
  nameIn.addEventListener('change', () => { setMyName(nameIn.value); if (s?.editing) renewLock().catch(() => {}); });
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
      <td class="acts"><button class="btn sub" data-open="${v.n}">열기</button>${s.editToken ? ` <button class="btn sub" data-restore="${v.n}">되돌리기</button>` : ''}</td></tr>`);
  }
  const body = el(`<div>저장할 때마다 버전이 남습니다 (최근 20개).</div>
    <div class="list"><table><tr><th>버전</th><th>저장 시각</th><th>저장한 사람</th><th>크기</th><th></th></tr>${rows.join('')}</table></div>`);
  const d = dialog('버전 기록', body);
  d.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', async () => { d.close(); await loadVersion(Number(b.dataset.open)); }));
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
  s.openedN = n;
  s.name = doc.name; s.format = doc.format;
  ctx.toast(`클라우드 문서를 열었습니다 (버전 ${n})`);
}

// 링크로 열기 (웹판은 주소에서, 설치형은 "링크로 열기")
export async function openLink(text) {
  const p = parseLink(text);
  if (!p) { ctx.toast('클라우드 링크가 아닙니다'); return false; }
  await leave();
  ctx.toast('클라우드에서 문서를 받는 중…');
  try {
    s = { id: p.id, keyStr: p.keyStr, key: await importKey(p.keyStr), editToken: p.editToken, lockId: null, editing: false, lockBy: null, openedN: 0 };
    const res = await call(`/api/docs/${s.id}`);
    if (res.status === 404) throw new Error('지워졌거나 없는 문서입니다');
    const info = await jsonOf(res);
    const last = info.versions?.[info.versions.length - 1];
    if (!last) throw new Error('아직 저장된 내용이 없는 문서입니다');
    await loadVersion(last.n);
    s.lockBy = info.lock ? await openText(s.key, info.lock.by) : null;
    connectLive();
    if (s.editToken && !info.lock) await startEditing(false);
    setHash();
    refreshBar();
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
    <div class="lk"><div class="r"><input placeholder="https://…#cloud=…"><button class="btn">열기</button></div></div>`);
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
async function startEditing(reloadLatest) {
  if (!s?.editToken) return false;
  try {
    if (reloadLatest) {
      const info = await jsonOf(await call(`/api/docs/${s.id}`));
      const last = info.versions?.[info.versions.length - 1];
      if (last && last.n !== s.openedN) await loadVersion(last.n);
    }
    const res = await call(`/api/docs/${s.id}/lock`, { method: 'POST', edit: true, body: JSON.stringify({ by: await sealText(s.key, myName()) }) });
    const r = await jsonOf(res);
    if (res.status === 409) { s.lockBy = await openText(s.key, r.lock?.by); s.editing = false; refreshBar(); return false; }
    if (!res.ok) throw new Error('편집 권한을 받지 못했습니다');
    s.lockId = r.lockId; s.editing = true; s.lockBy = null;
    clearInterval(s.beat);
    s.beat = setInterval(() => renewLock().catch(() => {}), HEARTBEAT);
    refreshBar();
    return true;
  } catch (e) { ctx.toast(e.message); return false; }
}
async function renewLock() {
  if (!s?.editing) return;
  const res = await call(`/api/docs/${s.id}/lock`, { method: 'POST', edit: true, body: JSON.stringify({ by: await sealText(s.key, myName()), lockId: s.lockId }) });
  if (res.status === 409) {
    // 오래 연결이 끊겨 잠금이 풀린 사이 다른 사람이 잡았다
    const r = await jsonOf(res);
    s.editing = false; s.lockId = null; clearInterval(s.beat);
    s.lockBy = await openText(s.key, r.lock?.by);
    refreshBar();
    showBar(`연결이 끊긴 사이 ${s.lockBy}님이 편집을 시작했습니다. 내 변경은 "다른 이름으로" 따로 저장해 주세요`, { ro: true, warn: true });
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
      if (my.editing) return;
      my.lockBy = m.lock ? await openText(my.key, m.lock.by) : null;
      refreshBar();
      if (!m.lock && my.editToken) {
        showBar('이제 편집할 수 있어요', { buttons: [{ label: '최신 버전 불러와 편집', primary: true, run: () => startEditing(true) }, { label: '나중에', run: () => refreshBar() }] });
      }
    } else if (m.type === 'deleted') {
      showBar('이 클라우드 문서는 지워졌습니다', { warn: true });
    }
  };
  ws.onclose = () => { if (s === my && !my.leaving) setTimeout(() => { if (s === my) connectLive(); }, 5000); };
  clearInterval(my.ping);
  my.ping = setInterval(() => { try { ws.send('ping'); } catch { /* 무시 */ } }, 25000);
}

/* ---------- 저장 ---------- */
let saving = false;
export async function saveToCloud() {
  if (saving) return;
  if (!API) { ctx.toast('클라우드 서버가 아직 준비되지 않았습니다'); return; }
  saving = true;
  try {
    if (s && !s.editToken) { ctx.toast('보기 전용 링크로 연 문서는 저장할 수 없습니다'); return; }
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
      if (!res.ok) throw new Error(r.message || '클라우드 문서를 만들지 못했습니다');
      const k = await newKey();
      s = { id: r.id, editToken: r.editToken, key: k.key, keyStr: k.str, lockId: null, editing: false, lockBy: null, openedN: 0 };
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
    const sealed = await packDoc(s.key, docNow);
    const res = await call(`/api/docs/${s.id}`, { method: 'PUT', edit: true, lock: true, headers: { 'X-Author': await sealText(s.key, myName()) }, body: sealed });
    const r = await jsonOf(res);
    if (res.status === 409) { s.editing = false; s.lockBy = await openText(s.key, r.lock?.by); refreshBar(); throw new Error(`${s.lockBy}님이 편집 중이라 저장하지 못했습니다`); }
    if (!res.ok) throw new Error(r.message || '클라우드에 저장하지 못했습니다');
    s.openedN = r.n; s.mySaved = r.n; s.name = docNow.name; s.format = docNow.format;
    s.savedAt = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    await ctx.markSaved?.();
    setHash();
    refreshBar();
    ctx.toast(`클라우드에 저장했습니다 (버전 ${r.n})`);
    if (fresh) shareDialog();
  } catch (e) {
    console.error(e);
    ctx.toast(e.message || '클라우드에 저장하지 못했습니다');
  } finally { saving = false; }
}

async function restoreVersion(n) {
  try {
    const old = await fetchVersion(n);
    if (!s.editing && !(await startEditing(false))) { ctx.toast(`${s.lockBy}님이 편집 중이라 되돌릴 수 없습니다`); return; }
    const res = await call(`/api/docs/${s.id}`, { method: 'PUT', edit: true, lock: true, headers: { 'X-Author': await sealText(s.key, myName()) }, body: await packDoc(s.key, old) });
    const r = await jsonOf(res);
    if (!res.ok) throw new Error(r.message || '되돌리지 못했습니다');
    s.mySaved = r.n;
    await loadVersion(r.n);
    refreshBar();
    ctx.toast(`버전 ${n}의 내용을 새 버전(${r.n})으로 되돌렸습니다`);
  } catch (e) { ctx.toast(e.message); }
}

/* ---------- 정리 ---------- */
// 다른 문서를 열거나 새 문서를 만들면 클라우드 문서에서 나온다
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
  const want = s ? `#cloud=${s.id}.${s.keyStr}${s.editToken ? `.${s.editToken}` : ''}` : '';
  if (location.hash !== want) history.replaceState(null, '', want || location.pathname + location.search);
}

export const isCloud = () => !!s;
export const canSave = () => !!(s && s.editToken);
export const available = () => !!API;

export function initCloud(context) {
  ctx = context;
  window.addEventListener('pagehide', () => { if (s?.editing) { try { fetch(`${API}/api/docs/${s.id}/lock`, { method: 'DELETE', headers: { 'X-Lock-Id': s.lockId }, keepalive: true }); } catch { /* 무시 */ } } });
  // 웹판: 주소에 클라우드 링크가 있으면 연다
  if (!ctx.desktop && parseLink(location.hash)) setTimeout(() => openLink(location.hash), 300);
  // 웹판을 연 채로 주소 줄에 다른 클라우드 링크를 붙여 넣은 경우
  window.addEventListener('hashchange', () => {
    const p = parseLink(location.hash);
    if (p && (!s || p.id !== s.id || p.editToken !== s.editToken)) openLink(location.hash);
  });
}
