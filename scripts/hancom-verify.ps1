<#
  한글(Hancom Office) 실제 열기·편집·다시 저장·PDF 확인 — 로컬 검증 도구 (WORKON 개편 P0).

    & .\scripts\hancom-verify.ps1 -InputPath a.hwpx -OutDir out [-Expect "값1","값2"] [-ExpectFile 기대글.json]

  하는 일(한글 COM 자동화 HWPFrame.HwpObject — 이 PC에 설치된 한글을 그대로 쓴다):
    1. 입력 HWPX를 한글로 연다(열리지 않으면 실패)
    2. 본문 글을 뽑아 -Expect 값이 모두 있는지 본다
    3. 문서 끝에 확인 문장을 넣고(편집) HWPX로 다시 저장한다
    4. 다시 저장한 파일을 새로 열어 확인 문장이 남았는지 보고, PDF로 내보낸다(쪽 수)
  결과는 JSON 한 줄로 찍는다. 시각 검토(쪽 배치·글꼴)는 사람이 PDF를 보고 한다 — 이 도구는 그것까지 판정하지 않는다.

  보안 모듈(FilePathCheckerModule)을 등록하지 않는다 — 레지스트리를 바꾸지 않는다.
  서버에서 돌리는 렌더러가 아니다(한글 사용권·Windows가 필요). 운영 렌더러는 별도 결정(ADR 0002).
#>
param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [string[]]$Expect = @(),
  # -File로 부르면 배열 인자가 나뉘지 않는다 — 기대 글 목록을 UTF-8 JSON 배열 파일로 받는다
  [string]$ExpectFile = '',
  [int]$TimeoutSec = 90
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
# PowerShell 5.1의 ConvertFrom-Json은 배열을 한 덩어리로 내보낸다 — 원소를 하나씩 꺼내 붙인다
if ($ExpectFile) { foreach ($e in ([IO.File]::ReadAllText((Resolve-Path $ExpectFile).Path, [Text.Encoding]::UTF8) | ConvertFrom-Json)) { $Expect += [string]$e } }
$InputPath = (Resolve-Path $InputPath).Path
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$base = [IO.Path]::GetFileNameWithoutExtension($InputPath)
# 한글은 접근 확인 창을 띄우는 위치(이 PC에서는 저장소 폴더)에서 자동화가 멈춘다 — 임시 폴더에서 열고 저장한 뒤 결과만 옮긴다
$work = Join-Path ([IO.Path]::GetTempPath()) ('workon-verify-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $work | Out-Null
$workInput = Join-Path $work "$base.hwpx"
Copy-Item $InputPath $workInput -Force
$edited = Join-Path $work "$base.hancom-edited.hwpx"
$pdf = Join-Path $work "$base.hancom.pdf"
$marker = 'WORKON-EDIT-CHECK-' + [guid]::NewGuid().ToString('N').Substring(0, 8)

$job = Start-Job -ArgumentList $workInput, $edited, $pdf, $marker {
  param($inputPath, $edited, $pdf, $marker)
  $r = [ordered]@{ opened = $false; version = $null; text = ''; editedSaved = $false; reopened = $false; editKept = $false; pdf = $false; pages = 0; error = $null }
  $h = $null
  try {
    $h = New-Object -ComObject HWPFrame.HwpObject
    $h.SetMessageBoxMode(0x00010000) | Out-Null
    $r.version = $h.Version
    $r.opened = [bool]$h.Open($inputPath, 'HWPX', 'forceopen:true')
    if (-not $r.opened) { throw '한글이 파일을 열지 못함' }
    # 'TEXT'는 옛 한국어 인코딩이라 ›·— 같은 글자를 버린다(실측) — 넣은 글 대조는 'UNICODE'로
    $r.text = [string]$h.GetTextFile('UNICODE', '')
    $h.Run('MoveDocEnd') | Out-Null
    $h.Run('BreakPara') | Out-Null
    $act = $h.CreateAction('InsertText'); $set = $act.CreateSet(); $act.GetDefault($set); $set.SetItem('Text', $marker); $act.Execute($set) | Out-Null
    $r.editedSaved = [bool]$h.SaveAs($edited, 'HWPX', '')
    $h.Clear(1)
    $r.reopened = [bool]$h.Open($edited, 'HWPX', 'forceopen:true')
    if ($r.reopened) {
      $r.editKept = ([string]$h.GetTextFile('UNICODE', '')).Contains($marker)
      $r.pdf = [bool]$h.SaveAs($pdf, 'PDF', '')
      $r.pages = [int]$h.PageCount
    }
  } catch {
    $r.error = $_.Exception.Message
  } finally {
    if ($h) { try { $h.Clear(1); $h.Quit() } catch {} }
  }
  return $r
}

$result = $null
if (Wait-Job $job -Timeout $TimeoutSec) { $result = Receive-Job $job } else {
  Stop-Job $job
  Get-Process Hwp -ErrorAction SilentlyContinue | Stop-Process -Force
  $result = [ordered]@{ opened = $false; error = "시간 초과($TimeoutSec초) — 한글 대화상자가 떴을 수 있음" }
}
Remove-Job $job -Force
$finalEdited = Join-Path $OutDir "$base.hancom-edited.hwpx"
$finalPdf = Join-Path $OutDir "$base.hancom.pdf"
if ($result.editedSaved) { Copy-Item $edited $finalEdited -Force }
if ($result.pdf) { Copy-Item $pdf $finalPdf -Force }
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue

$text = [string]$result.text
$missing = @($Expect | Where-Object { -not $text.Contains($_) })
$ok = [bool]($result.opened -and $result.editedSaved -and $result.reopened -and $result.editKept -and $result.pdf -and $missing.Count -eq 0 -and -not $result.error)
[ordered]@{
  ok = $ok
  input = $InputPath
  application = "Hancom $($result.version)"
  opened = $result.opened
  expectMissing = $missing
  editedSaved = $result.editedSaved
  editKept = $result.editKept
  pdf = $(if ($result.pdf) { $finalPdf } else { $null })
  pages = $result.pages
  editedHwpx = $(if ($result.editedSaved) { $finalEdited } else { $null })
  error = $result.error
  checkedAt = (Get-Date).ToString('o')
} | ConvertTo-Json -Compress
if (-not $ok) { exit 1 }
