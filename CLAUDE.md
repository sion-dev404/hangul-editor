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

## 명령
- 개발 서버: `npm run dev`
- 설치 파일: `npm run dist` → `release/HangulEditor-Setup-<버전>.exe`

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
- 순서: `tools/build-engine.ps1`(엔진 → `pkg-new/`) → `pkg/`와 `rhwp-studio/public/rhwp.js`에 복사 → `rhwp-studio`에서 `RHWP_WITHOUT_AI=1 npx vite build --base=./` → `tools/install-studio.ps1 -Studio <rhwp-studio 경로>`(엔진 파일 이름을 `rhwp_bg.wasm`으로 고정해 화면 쪽과 같이 쓴다).
- 빌드 한 번에 약 8~10분 걸린다. 배치 결과는 `tools/engine-check.mjs`로 Node에서 바로 확인한다(`all` 명령으로 수정 전후 비교).