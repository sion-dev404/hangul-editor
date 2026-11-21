# rhwp-studio 빌드 결과(dist)를 이 프로젝트의 public/studio로 옮긴다
# 사용: powershell -File tools\install-studio.ps1 -Studio <rhwp-src\rhwp-studio 경로>
param([Parameter(Mandatory = $true)][string]$Studio)
$ErrorActionPreference = 'Stop'
$proj = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dist = Join-Path $Studio 'dist'
$dst = Join-Path $proj 'public\studio'

# 서비스 워커·PWA 파일은 쓰지 않는다
Remove-Item "$dist\sw.js", "$dist\workbox-*.js", "$dist\registerSW.js", "$dist\manifest.webmanifest", "$dist\rhwp.d.ts", "$dist\rhwp_bg.wasm.d.ts" -Force -ErrorAction SilentlyContinue
$utf8 = New-Object Text.UTF8Encoding $false
$h = [IO.File]::ReadAllText("$dist\index.html")
$h = [regex]::Replace($h, '<script[^>]*registerSW\.js[^>]*></script>', '')
$h = [regex]::Replace($h, '<link[^>]*manifest\.webmanifest[^>]*>', '')
# 공공누리 글꼴 연결: rhwp 본체보다 먼저 실행되는 작은 파일을 넣는다 (tools\studio-kogl-hook.js)
Copy-Item (Join-Path $proj 'tools\studio-kogl-hook.js') "$dist\kogl-hook.js" -Force
if (-not $h.Contains('kogl-hook.js')) { $h = $h.Replace('<script src="./theme-init.js"></script>', "<script src=`"./kogl-hook.js`"></script>`n  <script src=`"./theme-init.js`"></script>") }
[IO.File]::WriteAllText("$dist\index.html", $h, $utf8)

# 엔진 파일 이름을 rhwp_bg.wasm으로 고정한다 (화면 쪽 src/engine.js가 같은 파일을 쓴다)
$wasm = Get-ChildItem "$dist\assets" -Filter 'rhwp_bg-*.wasm' | Select-Object -First 1
if ($wasm) {
  foreach ($js in Get-ChildItem "$dist\assets" -Filter *.js) {
    $t = [IO.File]::ReadAllText($js.FullName)
    if ($t.Contains($wasm.Name)) { [IO.File]::WriteAllText($js.FullName, $t.Replace($wasm.Name, 'rhwp_bg.wasm'), $utf8) }
  }
  Move-Item $wasm.FullName "$dist\assets\rhwp_bg.wasm" -Force
}

$src = Split-Path -Parent $Studio
Copy-Item "$src\LICENSE" "$dist\RHWP-LICENSE.txt" -Force
Copy-Item "$src\THIRD_PARTY_LICENSES.md" "$dist\RHWP-THIRD_PARTY_LICENSES.md" -Force
if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
Copy-Item $dist $dst -Recurse
"public/studio 크기(MB): " + [math]::Round((Get-ChildItem $dst -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
