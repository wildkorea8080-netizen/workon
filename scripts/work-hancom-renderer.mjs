/**
 * 한글(COM) 실제 파일 렌더러 — 로컬 Windows 작업자 전용(ADR 0002).
 * 저장한 그 파일(같은 sha256)을 이 PC의 한글이 열어 PDF로 내보낸다. 구조 미리보기가 아니라 실제 파일 렌더링이다.
 *
 * 운영 서버 렌더러가 아니다: 한글 사용권·Windows·데스크톱 세션이 필요하고 서버 배포 사용권은 확인되지 않았다.
 * 보안 모듈·레지스트리를 쓰지 않으므로 임시 폴더에서 열고 저장한다(scripts/hancom-verify.ps1과 같은 이유).
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';

const PS = `
param([string]$In, [string]$Out)
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$job = Start-Job -ArgumentList $In, $Out {
  param($In, $Out)
  $h = New-Object -ComObject HWPFrame.HwpObject
  try {
    $h.SetMessageBoxMode(0x00010000) | Out-Null
    if (-not $h.Open($In, 'HWPX', 'forceopen:true')) { throw 'open failed' }
    if (-not $h.SaveAs($Out, 'PDF', '')) { throw 'pdf failed' }
    "$($h.PageCount)|$($h.Version)"
  } finally { try { $h.Clear(1); $h.Quit() } catch {} }
}
if (Wait-Job $job -Timeout 90) { Receive-Job $job } else { Get-Process Hwp -ErrorAction SilentlyContinue | Stop-Process -Force; Stop-Job $job; 'timeout' }
Remove-Job $job -Force
`;

export const hancomRenderer = {
  name: 'hancom-com-local',
  async health() {
    if (process.platform !== 'win32') return { available: false, supportsHwpx: false, supportsPdf: false, reason: 'Windows가 아님' };
    const r = spawnSync('powershell', ['-NoProfile', '-Command', "if (Get-ItemProperty 'Registry::HKEY_CLASSES_ROOT\\HWPFrame.HwpObject' -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }"], { encoding: 'utf8' });
    const ok = (r.stdout || '').trim() === 'yes';
    return ok ? { available: true, supportsHwpx: true, supportsPdf: true } : { available: false, supportsHwpx: false, supportsPdf: false, reason: '한글 자동화 개체가 없음' };
  },
  async render({ bytes, sha256, format }) {
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('입력 해시가 다름');
    if (format !== 'hwpx') throw new Error('HWPX만 렌더링');
    const dir = mkdtempSync(path.join(tmpdir(), 'workon-render-'));
    try {
      const input = path.join(dir, 'doc.hwpx');
      const out = path.join(dir, 'doc.pdf');
      const script = path.join(dir, 'render.ps1');
      writeFileSync(input, bytes);
      writeFileSync(script, '﻿' + PS, 'utf8');
      const r = spawnSync('powershell', ['-NoProfile', '-File', script, '-In', input, '-Out', out], { encoding: 'utf8', timeout: 120_000 });
      const line = (r.stdout || '').trim().split('\n').pop() || '';
      if (!line.includes('|')) throw new Error(`한글 렌더링 실패: ${line.slice(0, 80)}`);
      const [pages, version] = line.split('|');
      return {
        inputSha256: sha256,
        renderer: { name: 'hancom-com-local', version: version.trim() },
        kind: 'actual_file_render',
        pageCount: Number(pages) || 0,
        pdf: readFileSync(out),
        warnings: ['로컬 한글 자동화 렌더링 — 운영 렌더러 아님'],
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
