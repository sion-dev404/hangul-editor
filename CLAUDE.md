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

## 명령
- 개발 서버: `npm run dev`
- 설치 파일: `npm run dist` → `release/HangulEditor-Setup-<버전>.exe`

## 주의
- `public/studio/`는 rhwp v0.9.0의 `rhwp-studio`를 `RHWP_WITHOUT_AI=1 npx vite build --base=./`로 빌드한 결과물이다(서비스 워커 파일은 지움). 다시 만들려면 저장소를 sparse로 받고 `pkg/`에 `@rhwp/core`의 `rhwp.js`, `rhwp_bg.wasm`을 넣는다. Windows에서는 `public/fonts` 심볼릭 링크가 깨지므로 `assets/fonts`를 직접 복사한다.
- rhwp 자체 메뉴(`#menu-bar`)와 아이콘 줄(`#icon-toolbar`)은 CSS를 넣어 가리고 서식 줄(`#style-bar`)만 남긴다. 같은 출처(origin)일 때만 가능하다.
- 개발 서버에서 `/studio/`는 앱 화면으로 돌아가므로 반드시 `/studio/index.html`로 지정한다.
- electron-builder의 winCodeSign 압축 풀기가 심볼릭 링크 권한으로 실패하면 `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0`에 직접 풀어 넣는다.

## rhwp 엔진을 고쳐서 다시 빌드하기
- `public/studio/`의 엔진(`rhwp_bg-*.wasm`)은 v0.9.0 소스에 `patches/`의 수정을 넣어 이 PC에서 직접 빌드한 것이다. 수정 내용: 글이 있는 문단에 "글 뒤로" 그림이 붙으면 그 문단 높이가 0이 되어 다음 문단이 겹치던 문제(`src/renderer/layout/shape_item.inc.rs`).
- 이 PC에는 C 컴파일러(MSVC/MinGW)가 없어 네이티브 Rust 실행 파일은 못 만든다. 그래서 다음 우회로를 쓴다.
  - Rust 1.93.1 `x86_64-pc-windows-gnu` + `wasm32-unknown-unknown`, `wasm32-wasip1` 타깃.
  - 툴체인의 `llvm-ar.exe`를 `llvm-dlltool.exe`로 복사하고 `-C dlltool=`로 지정(빌드 스크립트 링크용).
  - `wasm-bindgen` CLI 대신 `tools/wb-wasi`(wasm-bindgen-cli-support를 WASI로 빌드)를 Node로 실행.
- 순서: `tools/build-engine.ps1`(엔진 → `pkg-new/`) → `pkg/`와 `rhwp-studio/public/rhwp.js`에 복사 → `rhwp-studio`에서 `RHWP_WITHOUT_AI=1 npx vite build --base=./` → `tools/install-studio.ps1 -Studio <rhwp-studio 경로>`(엔진 파일 이름을 `rhwp_bg.wasm`으로 고정해 화면 쪽과 같이 쓴다).
- 빌드 한 번에 약 8~10분 걸린다. 배치 결과는 `tools/engine-check.mjs`로 Node에서 바로 확인한다(`all` 명령으로 수정 전후 비교).