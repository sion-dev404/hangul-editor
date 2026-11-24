// 문의함: 홍보 페이지의 문의 양식으로 온 글을 보관한다 (Durable Object 하나, 이름 "inbox")
// - 공개 이메일 대신 쓰므로 스팸 메일이 오지 않는다
// - 운영자는 /admin#k=<ADMIN_KEY> 페이지에서 읽고 지운다
export const CONTACT_KINDS = ['오류', '제안', '기타'];
export const CONTACT_MAX = 2000; // 글자 수
const MAX_KEEP = 1000; // 보관 최대 개수 (넘으면 새 문의를 받지 않음)
const EMAIL_OK = /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[^\s@<>]{2,}$/;

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const clean = (s, n) => String(s || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);

// 들어온 문의를 검사해 저장할 모양으로 만든다. 문제가 있으면 { error, message }
export function checkContact(b) {
  if (!b || typeof b !== 'object') return { error: 'bad', message: '잘못된 요청입니다' };
  if (b.website) return { spam: true }; // 사람 눈에는 안 보이는 칸: 채워져 있으면 로봇
  const kind = CONTACT_KINDS.includes(b.kind) ? b.kind : '기타';
  const msg = clean(b.message, CONTACT_MAX + 1);
  if (msg.length < 5) return { error: 'bad', message: '내용을 5자 이상 적어 주세요' };
  if (msg.length > CONTACT_MAX) return { error: 'bad', message: `내용은 ${CONTACT_MAX}자까지 적을 수 있습니다` };
  const email = clean(b.email, 254);
  if (email && !EMAIL_OK.test(email)) return { error: 'bad', message: '답장 받을 이메일 주소를 확인해 주세요' };
  return { item: { kind, msg, email } };
}

export class Inbox {
  constructor(state) { this.state = state; }
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const st = this.state.storage;
    if (path === '/add' && req.method === 'POST') {
      const count = (await st.get('count')) || 0;
      if (count >= MAX_KEEP) return json({ error: 'full', message: '문의함이 가득 찼습니다. 잠시 뒤에 다시 보내 주세요' }, 503);
      const item = await req.json();
      const t = Date.now();
      const key = `m:${String(t).padStart(15, '0')}:${crypto.randomUUID().slice(0, 8)}`;
      await st.put(key, { ...item, t });
      await st.put('count', count + 1);
      return json({ ok: true });
    }
    if (path === '/list') {
      const map = await st.list({ prefix: 'm:', reverse: true, limit: 500 });
      return json({ items: [...map].map(([id, v]) => ({ id, ...v })), count: (await st.get('count')) || 0 });
    }
    if (path === '/delete' && req.method === 'POST') {
      const { id } = await req.json().catch(() => ({}));
      if (typeof id !== 'string' || !id.startsWith('m:')) return json({ error: 'bad' }, 400);
      if (await st.get(id)) {
        await st.delete(id);
        await st.put('count', Math.max(0, ((await st.get('count')) || 1) - 1));
      }
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  }
}

// 운영자 문의함 페이지. 열쇠는 주소 # 뒤에 있어 서버 기록에 남지 않고, 읽은 뒤 주소에서 지운다.
export function adminPage() {
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>문의함 · 한글 편집기</title><link rel="icon" href="/logo.svg">
<style>
body{margin:0;background:#f3f5f8;color:#1d2433;font:15px/1.6 "Malgun Gothic","Apple SD Gothic Neo",sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:24px 16px 60px}
h1{font-size:22px;margin:0 0 4px;display:flex;align-items:center;gap:10px}h1 img{width:32px;height:32px}
.sub{color:#5b6475;margin:0 0 20px}
.bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
button{font:inherit;border:1px solid #d9dde5;background:#fff;border-radius:10px;padding:8px 14px;cursor:pointer}
button:hover{background:#f6f7fa}button.on{background:#139c90;border-color:#139c90;color:#fff}
.card{background:#fff;border:1px solid #e6e8ee;border-radius:14px;padding:16px 18px;margin-bottom:12px}
.top{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;color:#5b6475;font-size:13px}
.kind{font-weight:700;border-radius:999px;padding:2px 10px;background:#e6f6f4;color:#0f7f75}
.kind.오류{background:#ffe9e3;color:#c2412a}.kind.제안{background:#eef2ff;color:#3b4cc0}
.msg{white-space:pre-wrap;word-break:break-word}
.del{margin-left:auto;color:#c2412a;border-color:#f3c9bf}
.empty,.err{text-align:center;color:#5b6475;padding:40px 0}
</style><div class="wrap">
<h1><img src="/logo.svg" alt="">문의함</h1><p class="sub">홍보 페이지 문의 양식으로 온 글입니다. 이 페이지 주소는 다른 사람에게 알려 주지 마세요.</p>
<div class="bar" id="bar"></div><div id="list"><div class="empty">불러오는 중…</div></div></div>
<script>
(function(){
  var m=/[#&]k=([A-Za-z0-9_-]{20,})/.exec(location.hash);
  if(m){try{sessionStorage.setItem('ak',m[1]);}catch(e){} history.replaceState(null,'',location.pathname);}
  var key='';try{key=sessionStorage.getItem('ak')||'';}catch(e){}
  var list=document.getElementById('list'),bar=document.getElementById('bar'),items=[],filter='전체';
  function api(path,body){return fetch('/admin/api/'+path,{method:body?'POST':'GET',headers:{'X-Admin-Key':key,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}).then(function(r){if(r.status===403)throw new Error('key');return r.json();});}
  function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;}
  function drawBar(){bar.innerHTML='';['전체','오류','제안','기타'].forEach(function(k){var n=k==='전체'?items.length:items.filter(function(i){return i.kind===k;}).length;var b=el('button',k===filter?'on':'',k+' '+n);b.onclick=function(){filter=k;draw();};bar.appendChild(b);});var r=el('button','','새로 고침');r.onclick=load;bar.appendChild(r);}
  function draw(){drawBar();list.innerHTML='';var show=items.filter(function(i){return filter==='전체'||i.kind===filter;});
    if(!show.length){list.appendChild(el('div','empty','문의가 없습니다'));return;}
    show.forEach(function(i){var c=el('div','card'),top=el('div','top');top.appendChild(el('span','kind '+i.kind,i.kind));top.appendChild(el('span','',new Date(i.t).toLocaleString('ko-KR')));
      if(i.email){var a=el('a','',i.email);a.href='mailto:'+i.email;top.appendChild(a);}else top.appendChild(el('span','','(답장 주소 없음)'));
      var d=el('button','del','지우기');d.onclick=function(){d.disabled=true;api('delete',{id:i.id}).then(function(){items=items.filter(function(x){return x.id!==i.id;});draw();});};top.appendChild(d);
      c.appendChild(top);c.appendChild(el('div','msg',i.msg));list.appendChild(c);});}
  function load(){api('list').then(function(r){items=r.items||[];draw();}).catch(function(e){list.innerHTML='';list.appendChild(el('div','err',e.message==='key'?'열쇠가 맞지 않습니다. 받은 관리 주소로 다시 열어 주세요.':'불러오지 못했습니다'));});}
  if(!key){list.innerHTML='';list.appendChild(el('div','err','관리 주소(#k=…)로 열어 주세요.'));}else load();
})();
</script></html>`;
}
