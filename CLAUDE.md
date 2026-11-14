# 한글 편집기 (hangul-editor)

한글 문서(.hwp/.hwpx)와 워드 문서(.docx)를 워드식 리본 메뉴로 편집하는 프로그램. 웹(GitHub Pages)과 설치형(Electron exe) 두 가지로 나간다.

## 구조
- **한글 모드**: `public/studio/`에 넣어 둔 rhwp 편집기(오픈소스, MIT)를 iframe으로 띄우고 `src/hwp-mode.js`의 리본이 `studio.commands.execute()`로 조종한다. 문서를 그리고 저장하는 것은 전부 rhwp가 한다.
- **워드 모드**: `src/main.js`의 자체 편집기(contenteditable) + `src/docx-export.js`.
- **설치형**: `electron/main.cjs`가 `http://127.0.0.1:47615`로 `dist/`를 내준다. rhwp가 `file://`에서는 동작하지 않기 때문이다.
- **형식 변환**(docx↔hwp)과 "한글에서 열어 보기"는 설치형에서 한컴오피스 한글 자동화(COM)로 한다.

## 명령
- 개발 서버: `npm run dev`
- 설치 파일: `npm run dist` → `release/HangulEditor-Setup-<버전>.exe`

## 주의
- `public/studio/`는 rhwp v0.9.0의 `rhwp-studio`를 `RHWP_WITHOUT_AI=1 npx vite build --base=./`로 빌드한 결과물이다(서비스 워커 파일은 지움). 다시 만들려면 저장소를 sparse로 받고 `pkg/`에 `@rhwp/core`의 `rhwp.js`, `rhwp_bg.wasm`을 넣는다. Windows에서는 `public/fonts` 심볼릭 링크가 깨지므로 `assets/fonts`를 직접 복사한다.
- rhwp 자체 메뉴(`#menu-bar`)와 아이콘 줄(`#icon-toolbar`)은 CSS를 넣어 가리고 서식 줄(`#style-bar`)만 남긴다. 같은 출처(origin)일 때만 가능하다.
- 개발 서버에서 `/studio/`는 앱 화면으로 돌아가므로 반드시 `/studio/index.html`로 지정한다.
- electron-builder의 winCodeSign 압축 풀기가 심볼릭 링크 권한으로 실패하면 `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0`에 직접 풀어 넣는다.
