// 클라우드 서버 주소에서 보여 주는 안내 페이지 (Google 로그인 등록에 필요한 홈페이지·개인정보처리방침)
const WEB = 'https://sion-dev404.github.io/hangul-editor/';
const REPO = 'https://github.com/sion-dev404/hangul-editor';
const UPDATED = '2026년 11월 24일';

const shell = (title, body) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><link rel="icon" type="image/svg+xml" href="/logo.svg"><style>
:root{--ink:#1d2430;--sub:#5b6575;--line:#e1e5ea;--blue:#2f6fd6;--bg:#f3f5f8}
@media (prefers-color-scheme:dark){:root{--ink:#e6e9ef;--sub:#a9b2c0;--line:#2c3442;--blue:#7aa7f0;--bg:#141922}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15.5px/1.75 "Malgun Gothic","Apple SD Gothic Neo",sans-serif;word-break:keep-all}
main{max-width:760px;margin:0 auto;padding:40px 18px 60px}
.card{background:color-mix(in srgb,var(--bg) 20%,#fff 80%);border-radius:16px;padding:30px 30px 26px;box-shadow:0 8px 30px rgba(20,40,80,.08)}
@media (prefers-color-scheme:dark){.card{background:#1b2230}}
h1{font-size:26px;margin:0 0 6px}h2{font-size:18px;margin:28px 0 6px;padding-top:14px;border-top:1px solid var(--line)}
p,li{color:var(--ink)}.sub{color:var(--sub)}a{color:var(--blue)}
.logo{width:64px;height:64px;display:block;margin-bottom:14px}
.btns{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0 4px}.btns a{background:var(--blue);color:#fff;text-decoration:none;border-radius:10px;padding:10px 16px;font-weight:700}
.btns a.alt{background:transparent;color:var(--blue);border:1px solid var(--blue)}
footer{margin-top:22px;font-size:13px;color:var(--sub);text-align:center}
table{border-collapse:collapse;width:100%;font-size:14.5px}td,th{border-bottom:1px solid var(--line);padding:8px 6px;text-align:left;vertical-align:top}th{color:var(--sub);font-weight:700}
</style></head><body><main><div class="card">${body}</div>
<footer><a href="/">홈</a> · <a href="/terms">이용약관</a> · <a href="/privacy">개인정보처리방침</a> · <a href="${REPO}/issues">문의</a></footer></main></body></html>`;

export function homePage() {
  return shell('한글 편집기', `
<img class="logo" src="/logo.svg" alt="" width="64" height="64">
<h1>한글 편집기</h1>
<p class="sub">한컴오피스·MS 오피스 없이 한글(HWP·HWPX)과 워드(DOCX) 문서를 한 프로그램에서 열고, 고치고, 서로 바꾸는 무료 문서 편집기입니다.</p>
<div class="btns"><a href="${WEB}app.html">웹에서 바로 쓰기</a><a class="alt" href="${REPO}/releases/latest">Windows 설치 파일 받기</a></div>
<h2>이 주소는 무엇인가요?</h2>
<p>한글 편집기의 <b>클라우드 서버</b>입니다. 편집기에서 "클라우드에 저장"을 누르면 문서가 이곳에 보관되고, 공유 링크로 다른 사람과 함께 보거나 고칠 수 있습니다.</p>
<ul>
<li><b>문서는 내 PC에서 암호화한 뒤 올라갑니다.</b> 저장소에는 잠긴 상태로만 보관됩니다.</li>
<li><b>내 문서함</b>을 켜 두면 어느 PC에서나 로그인만으로 내 문서를 엽니다. 이때 문서 열쇠는 서버 비밀키로 다시 잠가 보관합니다. 내 문서함을 끄면 열쇠는 공유 링크 안에만 남아 서버도 문서를 열 수 없습니다.</li>
<li><b>회원가입</b>: 아이디와 비밀번호로 가입하거나, Google 계정으로 로그인합니다. 비밀번호는 알아볼 수 없게 바꾼 값(해시)만 보관하고, Google 계정의 비밀번호는 이 서버로 오지 않습니다.</li>
<li>한 번에 한 사람만 고칠 수 있고, 저장할 때마다 버전이 남습니다.</li>
</ul>
<p><a href="/terms">이용약관</a>과 <a href="/privacy">개인정보처리방침</a>에서 어떤 정보를 어떻게 다루는지 확인할 수 있습니다.</p>`);
}

export function termsPage() {
  return shell('이용약관 · 한글 편집기', `
<h1>이용약관</h1>
<p class="sub">한글 편집기 클라우드 · 시행일 ${UPDATED}</p>
<h2>1. 목적</h2>
<p>이 약관은 무료 문서 편집기 "한글 편집기"의 클라우드 기능(회원 계정, 문서 보관, 공유 링크, 버전 기록, 내 문서함, 이하 "서비스")을 이용하는 조건을 정합니다. 편집기만 쓰고 클라우드를 쓰지 않으면 회원가입이 필요 없습니다.</p>
<h2>2. 회원가입과 계정</h2>
<ul>
<li>아이디와 비밀번호로 가입하거나 Google 계정으로 로그인해 이용합니다. 가입할 때 이 약관과 개인정보처리방침에 동의해야 합니다.</li>
<li>만 14세 미만은 보호자의 동의를 받아 가입해야 합니다.</li>
<li>비밀번호와 <b>복구 코드</b>는 회원이 직접 관리합니다. 서비스는 메일·전화로 본인을 확인할 수단이 없으므로, 비밀번호와 복구 코드를 모두 잃으면 계정을 되찾을 수 없습니다.</li>
<li>다른 사람의 이름이나 아이디를 사칭하거나 계정을 남에게 넘기면 안 됩니다.</li>
</ul>
<h2>3. 서비스 내용</h2>
<ul>
<li>문서는 회원 기기에서 암호화된 뒤 보관되며, 문서마다 최근 20개 버전, 최대 30MB까지 보관합니다.</li>
<li>서비스는 무료로 제공되며, 운영 사정에 따라 기능이나 용량 제한이 바뀔 수 있습니다. 서비스를 끝내야 할 때는 30일 전에 이 페이지와 편집기에서 알립니다.</li>
<li>보관 장애에 대비해 중요한 문서는 내 PC에도 저장해 두기를 권합니다.</li>
</ul>
<h2>4. 금지 행위</h2>
<ul>
<li>법률을 어기는 내용(저작권 침해물, 불법 촬영물, 악성 코드 등)을 올리거나 공유하는 행위</li>
<li>자동화된 방법으로 계정을 대량으로 만들거나, 남의 비밀번호를 추측하는 행위</li>
<li>서버에 지나친 부하를 주거나 보안 장치를 우회하는 행위</li>
</ul>
<p>위반이 확인되면 사전 통지 없이 해당 문서나 계정의 이용을 제한할 수 있습니다.</p>
<h2>5. 회원 탈퇴</h2>
<p>회원은 언제든 편집기의 "계정 → 회원 탈퇴"에서 탈퇴할 수 있습니다. 탈퇴하면 내가 주인인 클라우드 문서와 내 문서함, 프로필이 지워지며 되돌릴 수 없습니다. 다른 사람 문서의 편집자 목록에서도 빠집니다. 탈퇴한 아이디는 비워져 다시 가입할 수 있지만, 옛 문서 권한·프로필·복구 코드는 이어지지 않습니다.</p>
<h2>6. 책임의 한계</h2>
<p>서비스는 무료로 "있는 그대로" 제공됩니다. 운영자는 고의나 중대한 과실이 없는 한 서비스 중단, 데이터 손실, 회원의 비밀번호·링크 관리 소홀로 생긴 손해에 책임지지 않습니다.</p>
<h2>7. 약관 변경과 문의</h2>
<p>약관이 바뀌면 시행 7일 전에 이 페이지에 알립니다. 문의는 <a href="${WEB}#contact">웹판의 문의 양식</a>이나 <a href="${REPO}/issues">GitHub 저장소의 문의(Issues)</a>로 남겨 주세요.</p>`);
}

export function privacyPage() {
  return shell('개인정보처리방침 · 한글 편집기', `
<h1>개인정보처리방침</h1>
<p class="sub">한글 편집기 클라우드 · 시행일 ${UPDATED}</p>
<p>한글 편집기(이하 "편집기")는 클라우드 기능을 제공하는 데 꼭 필요한 정보만 처리합니다. 클라우드 기능을 쓰지 않으면 어떤 개인정보도 서버로 보내지 않습니다.</p>

<h2>1. 처리하는 정보와 목적</h2>
<table>
<tr><th>정보</th><th>목적</th><th>보관</th></tr>
<tr><td>아이디 회원: 아이디</td><td>로그인, 문서 주인·편집자 권한 확인, 탈퇴할 때 편집자 목록에서 빼기 위해 내가 편집자로 들어간 문서 번호 기록</td><td>탈퇴할 때까지 (탈퇴하면 다른 사람 문서의 편집자 목록에서도 지움)</td></tr>
<tr><td>아이디 회원: 비밀번호</td><td>본인 확인. 원래 비밀번호는 보관하지 않고 되돌릴 수 없는 값(PBKDF2 해시)만 보관</td><td>탈퇴할 때까지</td></tr>
<tr><td>아이디 회원: 복구 코드</td><td>비밀번호를 잊었을 때 되찾기. 해시만 보관</td><td>탈퇴할 때까지</td></tr>
<tr><td>프로필: 이름(별명), 사진(선택)</td><td>편집기 화면의 계정 표시</td><td>바꾸거나 탈퇴할 때까지</td></tr>
<tr><td>약관 동의 시각</td><td>이용약관·개인정보처리방침 동의 기록</td><td>탈퇴할 때까지</td></tr>
<tr><td>접속 주소(IP)</td><td>가입·로그인 시도 횟수 제한(남용·비밀번호 추측 방지). 하루 횟수만 기록</td><td>당일 횟수만, 다음 날 덮어씀</td></tr>
<tr><td>Google 계정 이메일 주소</td><td>로그인, 문서 주인·편집자 권한 확인, 버전을 저장한 계정 기록</td><td>해당 문서가 지워질 때까지</td></tr>
<tr><td>Google 계정 이름</td><td>편집기 화면에 "○○님 편집 중"으로 표시 (암호화되어 저장되어 서버는 읽을 수 없음)</td><td>해당 문서가 지워질 때까지</td></tr>
<tr><td>Google 계정 고유 번호</td><td>하루에 만들 수 있는 문서 수 제한(남용 방지)</td><td>당일 횟수만, 다음 날 덮어씀</td></tr>
<tr><td>내 문서함: 문서 열쇠·파일 이름·종류·내 역할</td><td>어느 PC에서나 로그인만으로 내 클라우드 문서 목록을 보고 열기 위함. 서버 비밀키로 다시 잠가 계정별로 보관</td><td>목록에서 빼거나, 내 문서함을 끄거나, 문서가 지워질 때까지</td></tr>
<tr><td>문의 양식: 문의 종류·내용, 답장 받을 이메일(선택)</td><td>문의에 답하고 오류를 고치기 위함. 운영자만 봄</td><td>처리가 끝나면 지우며, 늦어도 1년 안에 지움</td></tr>
<tr><td>로그인 유지 표</td><td>다시 로그인하지 않고 쓰기 위함. 이용자 기기에만 저장되며 서버에는 보관하지 않음</td><td>30일 또는 로그아웃할 때까지</td></tr>
</table>
<p>아이디 회원 가입에는 이메일·전화번호 등 다른 연락처를 받지 않습니다. 편집기는 Google 계정에서 <b>이메일, 이름, 계정 고유 번호</b>만 받습니다. 비밀번호, 연락처, 드라이브 등 다른 정보에는 접근하지 않습니다.</p>

<h2>2. 문서 내용과 열쇠</h2>
<p>클라우드에 올리는 문서와 파일 이름은 <b>이용자 기기에서 AES-256 방식으로 암호화한 뒤</b> 서버에 보관합니다. 문서마다 최근 20개 버전을 보관하며, 문서 주인이 문서를 지우면 모든 버전이 함께 지워집니다.</p>
<p><b>내 문서함(기본 켜짐)</b>: 로그인한 이용자가 문서를 저장하거나 열면, 그 문서의 열쇠를 이용자 계정의 보관함에 둡니다. 열쇠는 계정마다 다른 서버 비밀키로 다시 암호화되어, 저장소가 유출되더라도 읽을 수 없습니다. 다만 서버가 열쇠를 풀 수 있는 구조이므로, 서버 자체가 침해되면 문서가 열릴 수 있습니다(일반 클라우드 문서 서비스와 같은 수준). 운영자는 장애 대응 등 불가피한 경우를 제외하고 열쇠나 문서에 접근하지 않습니다.</p>
<p><b>내 문서함을 끄면</b>(편집기의 "계정"에서) 보관한 열쇠를 모두 지우고, 이후 열쇠는 공유 링크의 # 뒤에만 남습니다. 이 경우 운영자도 문서를 열 수 없으며, 링크를 잃어버리면 문서를 되살릴 수 없습니다.</p>

<h2>3. 제3자 제공과 처리 위탁</h2>
<p>개인정보를 다른 곳에 팔거나 제공하지 않습니다. 서비스 운영을 위해 다음 업체의 서비스를 이용합니다.</p>
<ul>
<li><b>Cloudflare, Inc.</b> — 클라우드 서버 운영과 데이터 보관 (보안을 위해 접속 기록을 처리할 수 있음)</li>
<li><b>Google LLC</b> — 계정 로그인 확인</li>
</ul>

<h2>4. 이용자의 권리</h2>
<ul>
<li>편집기의 "계정"에서 언제든 로그아웃할 수 있습니다.</li>
<li><b>회원 탈퇴</b>: 편집기의 "계정 → 회원 탈퇴"에서 바로 탈퇴할 수 있습니다. 탈퇴하면 내가 주인인 클라우드 문서(모든 버전), 내 문서함, 프로필, 비밀번호 정보가 지워지고 모든 기기의 로그인이 끊깁니다.</li>
<li>내가 주인인 문서는 언제든 지울 수 있고, 지우면 관련 정보가 함께 지워집니다.</li>
<li>"내 문서"에서 목록을 빼거나, "계정"에서 내 문서함을 끄면 보관한 열쇠가 지워집니다.</li>
<li>Google 계정 설정(보안 → 타사 앱 연결)에서 편집기의 접근 권한을 해제할 수 있습니다.</li>
<li>정보의 열람·삭제를 원하면 아래 문의처로 요청할 수 있습니다.</li>
</ul>

<h2>5. 쿠키</h2>
<p>클라우드 서버는 쿠키를 쓰지 않습니다. 로그인 유지 표는 편집기 안(브라우저 저장소)에만 저장됩니다.</p>

<h2>6. 어린이</h2>
<p>만 14세 미만 이용자는 보호자의 동의를 받아 이용해야 합니다.</p>

<h2>7. 문의</h2>
<p>개인정보와 관련된 문의는 <a href="${WEB}#contact">웹판의 문의 양식</a>이나 <a href="${REPO}/issues">GitHub 저장소의 문의(Issues)</a>로 남겨 주세요.</p>

<h2>8. 바뀌는 경우</h2>
<p>이 방침이 바뀌면 이 페이지에 시행일과 함께 알립니다.</p>`);
}
