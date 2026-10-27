<#
  WORKON 표준 양식 3종을 한글로 만든다 (WORKON 개편 P0).

    & .\scripts\build-standard-templates.ps1            # assets/templates/src/*.html → assets/templates/*.hwpx

  원본은 assets/templates/src/의 HTML(서식·표시 위치)이다. 한글(HWPFrame.HwpObject)이 HTML을 열어 HWPX로 저장한다 —
  파일은 한글이 쓴 진짜 HWPX다(코드로 XML을 짜 맞춘 것이 아님, assets/templates/README.md 원칙).
  쪽 배치·글꼴의 시각 검토는 사람이 한다(scripts/hancom-verify.ps1이 PDF를 만든다).

  보안 모듈·레지스트리는 건드리지 않는다. 그래서 한글이 접근 확인 창을 띄우는 위치(이 PC에서는 저장소 폴더)에서는
  자동화가 멈춘다 — 임시 폴더에서 변환한 뒤 결과만 assets/templates/로 복사한다.
#>
param([int]$TimeoutSec = 90)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'assets\templates\src'
$dst = Join-Path $root 'assets\templates'
$work = Join-Path ([IO.Path]::GetTempPath()) ('workon-templates-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $work | Out-Null

try {
  foreach ($name in @('official_letter', 'report', 'minutes')) {
    $html = Join-Path $work "$name.html"
    $out = Join-Path $work "$name.hwpx"
    Copy-Item (Join-Path $src "$name.html") $html -Force
    $job = Start-Job -ArgumentList $html, $out {
      param($html, $out)
      $h = New-Object -ComObject HWPFrame.HwpObject
      try {
        $h.SetMessageBoxMode(0x00010000) | Out-Null
        if (-not $h.Open($html, 'HTML', 'forceopen:true')) { throw "열기 실패: $html" }
        if (-not $h.SaveAs($out, 'HWPX', '')) { throw "저장 실패: $out" }
        $h.Version
      } finally { try { $h.Clear(1); $h.Quit() } catch {} }
    }
    if (Wait-Job $job -Timeout $TimeoutSec) { $version = Receive-Job $job } else {
      Get-Process Hwp -ErrorAction SilentlyContinue | Stop-Process -Force
      Stop-Job $job
      throw "시간 초과: $name"
    }
    Remove-Job $job -Force
    Copy-Item $out (Join-Path $dst "$name.hwpx") -Force
    "$name.hwpx (Hancom $version)"
  }
} finally {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
