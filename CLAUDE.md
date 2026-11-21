# 한글 편집기 (hangul-editor)

한글 문서(.hwp/.hwpx)와 워드 문서(.docx)를 워드식 리본 메뉴로 편집하는 프로그램. 웹(GitHub Pages)과 설치형(Electron exe) 두 가지로 나간다.

## 구조
- **한글 모드**: `public/studio/`에 넣어 둔 rhwp 편집기(오픈소스, MIT)를 iframe으로 띄우고 `src/hwp-mode.js`의 리본이 `studio.commands.execute()`로 조종한다. 문서를 그리고 저장하는 것은 전부 rhwp가 한다.
- **워드 모드**: `src/main.js`의 자체 편집기(contenteditable) + `src/docx-export.js`.
- **설치형**: `electron/main.cjs`가 `http://127.0.0.1:47615`로 `dist/`를 내준다. rhwp가 `file://`에서는 동작하지 않기 때문이다.
- **형식 변환은 한글 프로그램 없이** 한다(사용자 지시: 한글이 없는 PC 기준).
  - 워드 파일 열기: `src/docx-import.js`가 docx XML을 직접 해석해 워드 편집 화면에 연다.
  - 워드 화면 → 한글 저장: `src/engine.js`가 rhwp 엔진(`src/vendor/rhwp-core.js` + `public/studio/assets/rhwp_bg.wasm`)의 `pasteHtml`로 만든다. 목록은 번호를 글자로 바꿔 넣는다(엔진이 번호를 글머리표로 바꾸기 때문).
  - 한글 화면 → 워드 저장: rhwp `exportHwpx` → `src/hwpx-import.js` → `#exportStage`에 그려서 `docx-export.js`.
  - 한글 프로그램은 "한글에서 열어 보기" 단추에만 쓴다(없으면 숨김). 점검할 때 `HANGUL_EDITOR_NO_HANCOM=1`이면 없는 PC처럼 동작한다.
- **줄 간격 약속**: 워드 "1줄"은 화면(CSS)에서 글자 크기의 1.3배(`WORD_LINE`). 불러올 때 곱하고 저장할 때 나눈다. 이 값을 바꾸면 워드 왕복 쪽 수가 달라진다.
- **첨자**: 화면에서는 1/1.2 크기를 직접 적는다(`font-size:smaller`는 부모 기준이라 틀어짐). 워드·한글로 낼 때 1.2배로 되돌린다.
- **머리글·바닥글**: 워드 화면에서는 보이지 않지만 `doc.parts`에 담아 두었다가 워드로 저장할 때 다시 넣는다(쪽 번호는 `span[data-field=page]`).
- **이 편집기로 저장한 docx**에는 원본 HTML(`hangulEditor/content.xml`)과 `word/document.xml`의 지문(`docHash`)을 넣는다. 다른 프로그램에서 고쳐 지문이 다르면 원본 대신 워드 내용을 읽는다.
- **한글 → 워드(hwpx-import)**: 문서에 저장된 줄 배치(lineseg)로 줄 높이를 정하고, 떠 있는 그림은 같은 기준·거리의 떠 있는 그림으로, 바탕쪽 그림은 머리글 안 "글 뒤" 그림으로, 글 없는 도형(배경 띠·점선 답 칸)은 덮는 문단의 음영·테두리로 옮긴다. WMF 그림은 `src/wmf.js`가 PNG로 그린다.

## 화면 구성 (한글 2024식 밝은 화면)
- 제목 줄: 로고 · 빠른 실행(새 문서·열기·저장·인쇄·되돌리기·다시 실행, 화면 종류별로 `#quickDocx`/`#quickHwp`) · 문서 이름(가운데) · 종류 · 저장 상태.
- 탭 + 리본, 그 아래 서식 줄. 한글 화면의 서식 줄은 rhwp 안에 있고, 워드 화면의 서식 줄은 `#fmtBar`(스타일·글꼴·크기·굵게·정렬·줄 간격·목록)다.
- 아이콘은 `src/icons.js`에서 직접 그린 SVG만 쓴다. 한컴·마이크로소프트의 아이콘·로고·그림은 저작권·상표 문제로 쓰지 않는다. 버튼에는 `data-ico="이름"`을 달면 채워진다.
- **자동 복구**: 한글 화면은 고친 내용이 있으면 15초마다 문서를 IndexedDB(`src/recovery.js`, 키 `hwp`)에 넣고, 저장하면 지운다. 다음 실행에서 되살릴지 묻는다. 워드 화면은 localStorage에 저장하고, 용량이 넘으면 IndexedDB(키 `docx`)에 넣는다.
- **머리말·꼬리말(워드 화면)**: `doc.parts = { header, footer }`(HTML). 화면 맨 위·아래 여백에 미리 보이고(`#hdrView`/`#ftrView`), 눌러서 대화 상자(`#hfDlg`)로 고친다. 쪽 번호는 `span[data-field=page]`로 저장 때 워드의 쪽 번호 필드가 된다. 인쇄(PDF)에는 아직 들어가지 않는다.

## 함께 넣은 글꼴 (공공누리 제1유형)
- `node tools/fetch-fonts.mjs`(=`npm run fonts`, `npm run dist`가 자동 실행)가 공유마당 "공공 안심글꼴"(모두 공공누리 제1유형: 출처표시 조건으로 상업 이용·변형 허용)을 받아 `public/fonts/kogl/`에 WOFF와 `manifest.json`, `출처표시.txt`를 만든다. 받은 압축은 `.font-cache/`에 두고 다시 받지 않는다. 두 폴더 모두 git에 넣지 않는다(용량).
- `--pick=tools/font-picks.txt`: 아직 안 받은 것 중 적힌 이름만 받는다. `--force`: 목록을 다시 만든다. `node tools/missing-fonts.mjs`: 안 받은 글꼴 이름 보기.
- 글꼴마다 otf·ttf(및 깨진 kern/vhea 표를 뺀 판)를 후보로 만들고 `tools/font-validate.cjs`(Electron)로 실제 화면 엔진에서 열리는지 시험해 고른다. 어느 것도 안 열리는 글꼴(감탄로드·소요단풍·전주 완판본 순체 등 16개)은 뺀다.
- 워드 화면: `src/fonts.js`가 @font-face를 선언한다.
- 한글 화면(rhwp): rhwp의 기본 그리기 방식은 **Canvas 2D**(CanvasKit 아님, `?renderer=canvaskit`일 때만)다. 엔진은 Canvas에 `13px "글꼴이름", 대체…`를 넘기는데, rhwp가 `CanvasRenderingContext2D.font` 설정을 감싸(`wl.resolve`) "쓸 수 있는 글꼴"이 아니면 이름을 대체 글꼴로 바꾼다. 그래서:
  - `tools/patch-studio.mjs`가 rhwp 코드(`public/studio/assets/index-*.js`, 압축된 이름)의 그 판단(`u=…||In.has(e)||…`)에 `window.__koglHas(e)`를, CanvasKit용 글꼴 표 함수 맨 앞에 `window.__koglTn(표,이름정리)`를 넣고, `kogl-hook.js`를 `index.html`·`print.html`에 넣는다. `install-studio.ps1`이 자동 실행한다. rhwp 버전이 바뀌면 정규식이 안 맞아 오류로 멈추니 그때 고친다.
  - `tools/studio-kogl-hook.js`(→ `public/studio/kogl-hook.js`)는 manifest를 동기로 읽고 @font-face를 선언한 뒤, Canvas가 공공누리 글꼴 이름을 처음 쓰면 `document.fonts.load()`로 받는다. 받기가 끝나면 rhwp가 `loadingdone`에서 글자 폭을 다시 재고 다시 그린다. 인쇄 창은 `document.fonts.ready`를 기다린 뒤 인쇄한다.
- 글꼴 상자: 한글 화면은 **rhwp 글꼴 메뉴 모양 그대로** 두고, `patch-studio.mjs`가 분류 단추 맨 뒤에 "공공누리"(`window.__koglMenu`)를 더하고 "모든 글꼴"에도 넣으며, 목록 항목에 `window.__koglBadge`로 공공누리 표시를 붙인다(사용자 지시: 한글의 글꼴 창 디자인 유지). 워드 화면은 기본 상자에 그림을 넣을 수 없어 `src/fontpicker.js`의 목록을 쓴다.
- 출처 표시: 파일 탭의 "글꼴 출처"가 `출처표시.txt`를 연다.

## 설치 프로그램 (우리 디자인)
- 설치 마법사(NSIS) 대신 직접 만든 설치 화면을 쓴다. electron-builder는 `--dir`로 `release/win-unpacked`만 만들고, `tools/make-setup.mjs`가 그 폴더를 zip으로 묶어 `tools/setup/Setup.cs`(C# WPF, Windows 기본 .NET Framework 4의 `csc.exe`)에 넣어 컴파일한다. 같은 소스를 `/define:UNINSTALL`로 컴파일한 지우기 프로그램(`Uninstall 한글 편집기.exe`)이 설치 폴더에 들어간다.
- 기본 설치 위치는 내 계정(`%LOCALAPPDATA%Programshangul-editor`)이라 관리자 확인 창이 없다. 등록 정보는 HKCU `...Uninstallio.github.sion-dev404.hangul-editor`(Windows "앱 제거"에 나옴).
- 예전 마법사로 깐 판(제거 정보의 `Uninstall 한글 편집기.exe`)이 있으면 `/S _?=폴더`로 지우고 바꾼다. 컴퓨터 전체 설치였으면 그때만 관리자 확인 창이 뜬다. 편집기가 켜져 있으면 창 닫기를 부탁하고 기다린다(저장 안 한 내용은 편집기가 묻는다).
- 명령줄: `/S`(창 없이), `--dir=`, `--no-desktop`, `--no-launch`, `--test`(파일만 풀기, 점검용), `--snap=`(화면 그림만). 지우기: `/S`, `--purge`(설정·자동 복구 자료까지).
- C# 소스는 C# 5 문법만 된다(`?.`, `$""` 안 됨). 문자열 안에 진짜 줄바꿈을 넣지 말 것(`
`).

## 클라우드 (Cloudflare, 우리 서버)
- 사용자 결정(2026-11-21): "공유받은 문서함"(편집자 자동 공유)은 실효성 없음으로 **파기**. 최우선 목표는 자체 엔진 **hwpcore**.
- 사용자 결정: 실시간 동시 타이핑 없음. "한 명이 고치는 동안 나머지는 보기 + 버전 기록 + 공유 링크". 로그인은 Google(심사 없이, 로고 없이 게시 — Google 화면에는 앱 이름 대신 도메인이 보임). 비밀번호·보관함 비밀번호는 쓰지 않는다. 다른 사람에게 자동 공유(공유받은 문서함)는 파기.
- 서버: `cloud/` (Workers + Durable Objects, 카드 없는 무료 요금제라 R2 대신 DO 저장소에 1MB 조각). 주소 https://hangul-editor-cloud.hangul-editor-cloud.workers.dev (홈 `/`, 개인정보처리방침 `/privacy` — `cloud/src/pages.js`).
  - DocRoom: 주인·편집자(이메일), 편집 잠금 90초(편집기가 30초마다 연장, 같은 계정은 다른 PC에서 넘겨받기 가능), 버전 최근 20개, 최대 30MB, WebSocket 알림.
  - 로그인: Google OIDC → PKCE 1회용 코드(2분) → 서명 세션(30일). 설치형은 브라우저 로그인 뒤 내장 서버 `/__auth`로 코드를 받는다.
  - 내 문서함(Vault, 계정 이메일별): 문서 열쇠·이름을 HKDF(VAULT_SECRET, 이메일) AES-GCM으로 다시 잠가 보관 → 어느 PC에서나 "내 문서"로 연다. 끄면 열쇠를 모두 지운다(그때는 링크만, 서버도 못 엶). 개인정보처리방침에 한계(서버가 뚫리면 열릴 수 있음)를 밝혀 두었다.
  - 비밀값(wrangler secret): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET, VAULT_SECRET. 로컬은 `cloud/.dev.vars`(DEV_LOGIN=1 가짜 로그인, git 제외).
- 편집기: `src/cloud.js`. 문서·파일 이름·작성자 이름은 이 PC에서 AES-GCM으로 잠가 올린다. 링크 `#cloud=<id>.<열쇠>`. 파일 탭 "클라우드"(내 문서·클라우드에 저장·공유 링크·버전 기록·링크로 열기·계정), 화면 아래 상태 줄.
- 개발: `cd cloud && npx wrangler dev --port 8787` + 개발 서버(5173·5198·5199)면 로컬 서버를 쓴다. 시험: `node cloud/test/api-test.mjs`(보안 시험 포함).
- 배포: `cd cloud && npx wrangler deploy` (계정 gemisionkim@gmail.com, Google Cloud 프로젝트 hangle-aditor). 서버 배포는 git push와 별개.

## 버전 규칙
- 3.x = 클라우드 세대: 혼자 쓰는 편집기(2.x)에서 우리 서버·Google 로그인·공유·편집 잠금·버전 기록·내 문서함·자체 설치 프로그램을 갖춘 문서 서비스로 바뀐 세대.
- 3.0 = 클라우드 출발(2.7.0의 클라우드·로그인·공유에 해당), 3.1.0 = 내 문서함(비밀번호 없이 어느 PC에서나)과 다른 PC 편집 넘겨받기(2.8.0과 같은 내용을 3.x 체계로 다시 냄).
- 앞으로: 기능 추가 = 가운데 숫자(3.2.0), 고침만 = 끝 숫자(3.1.1), 세대가 바뀔 만큼 큰 변화 = 앞 숫자.

## 명령
- 개발 서버: `npm run dev`
- 설치 파일: `npm run dist` → `release/HangulEditor-Setup-<버전>.exe` (설치 화면만 다시 만들 때: `npm run setup`, 화면 그림만 뽑기: `node tools/make-setup.mjs --snap=<폴더>`)

## 주의
- `public/studio/`는 rhwp v0.9.0의 `rhwp-studio`를 `RHWP_WITHOUT_AI=1 npx vite build --base=./`로 빌드한 결과물이다(서비스 워커 파일은 지움). 다시 만들려면 저장소를 sparse로 받고 `pkg/`에 `@rhwp/core`의 `rhwp.js`, `rhwp_bg.wasm`을 넣는다. Windows에서는 `public/fonts` 심볼릭 링크가 깨지므로 `assets/fonts`를 직접 복사한다.
- rhwp 자체 메뉴(`#menu-bar`)와 아이콘 줄(`#icon-toolbar`)은 CSS를 넣어 가리고 서식 줄(`#style-bar`)만 남긴다. 같은 출처(origin)일 때만 가능하다.
- 개발 서버에서 `/studio/`는 앱 화면으로 돌아가므로 반드시 `/studio/index.html`로 지정한다.
- electron-builder의 winCodeSign 압축 풀기가 심볼릭 링크 권한으로 실패하면 `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0`에 직접 풀어 넣는다.

## rhwp 엔진을 고쳐서 다시 빌드하기
- `public/studio/`의 엔진(`rhwp_bg-*.wasm`)은 v0.9.0 소스에 `patches/`의 수정을 넣어 이 PC에서 직접 빌드한 것이다. 수정 내용:
  - 글이 있는 문단에 "글 뒤로" 그림이 붙으면 그 문단 높이가 0이 되어 다음 문단이 겹치던 문제(`src/renderer/layout/shape_item.inc.rs`).
  - HTML 붙여 넣기에서 `background-color`(형광펜 → 글자 음영), `vertical-align`(위·아래 첨자), `page-break-before:always`(문단 앞 쪽 나눔)를 읽게 함(`html_import/inline_content.rs`, `html_import.rs`).
- 이 PC에는 C 컴파일러(MSVC/MinGW)가 없어 네이티브 Rust 실행 파일은 못 만든다. 그래서 다음 우회로를 쓴다.
  - Rust 1.93.1 `x86_64-pc-windows-gnu` + `wasm32-unknown-unknown`, `wasm32-wasip1` 타깃.
  - 툴체인의 `llvm-ar.exe`를 `llvm-dlltool.exe`로 복사하고 `-C dlltool=`로 지정(빌드 스크립트 링크용).
  - `wasm-bindgen` CLI 대신 `tools/wb-wasi`(wasm-bindgen-cli-support를 WASI로 빌드)를 Node로 실행.
- **엔진 소스 위치: `C:\Users\redsi\swpro\rhwp-src`** (git으로 기록, 출발점 커밋 = rhwp 0.9.0 + 위 수정). 빌드 도구 `C:\Users\redsi\swpro\wb-wasi`, `C:\Users\redsi\swpro\build-engine.ps1`(이 폴더 기준으로 동작). hwpcore(자체 엔진)는 이 소스에서 단계적으로 키운다.
- 순서: `tools/build-engine.ps1`(엔진 → `pkg-new/`) → `pkg/`와 `rhwp-studio/public/rhwp.js`에 복사 → `rhwp-studio`에서 `RHWP_WITHOUT_AI=1 npx vite build --base=./` → `tools/install-studio.ps1 -Studio <rhwp-studio 경로>`(엔진 파일 이름을 `rhwp_bg.wasm`으로 고정해 화면 쪽과 같이 쓴다).
- 빌드 한 번에 약 8~10분 걸린다. 배치 결과는 `tools/engine-check.mjs`로 Node에서 바로 확인한다(`all` 명령으로 수정 전후 비교).