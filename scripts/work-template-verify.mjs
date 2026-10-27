/**
 * 기본 양식 실제 한글 검증 (WORKON 개편 P0) — Windows + 한글 설치 PC에서만 돈다.
 *
 *   npm run work:template-verify            -- 세 양식을 채워 한글에서 열기·편집·다시 저장·PDF, 기록 남김
 *   npm run work:template-verify -- --out 폴더  -- 채운 파일·PDF를 그 폴더에 둔다(기본: 임시 폴더)
 *
 * 1. 실제 입구(readTemplate·fillTemplate)로 양식마다 모든 표시에 예시 글(여러 줄 포함)을 넣는다
 * 2. scripts/hancom-verify.ps1로 한글이 연다 → 넣은 글이 보이는지 → 편집 → 다시 저장 → 다시 열기 → PDF
 * 3. 통과하면 assets/templates/verification.json에 { file, sha256, kind: 'hancom-automation', ... }를 남긴다
 *
 * 사람의 시각 검토(쪽 배치·글꼴·잘림)는 이 스크립트가 하지 않는다 — PDF를 사람이 보고
 * verification.json에 kind 'human-visual' 기록을 직접 더한다(npm run work:template-check -- --release가 요구).
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { readTemplate, fillTemplate } from '../src/lib/doc-fill/index.ts';
import { BUILTIN_TEMPLATES, BUILTIN_TEMPLATE_DIR } from '../src/lib/builtin-templates.ts';

if (process.platform !== 'win32') {
  console.error('Windows + 한글이 설치된 PC에서만 돈다.');
  process.exit(1);
}
const outIdx = process.argv.indexOf('--out');
const outDir = outIdx > 0 ? path.resolve(process.argv[outIdx + 1]) : mkdtempSync(path.join(tmpdir(), 'workon-tplverify-'));
mkdirSync(outDir, { recursive: true });

const SAMPLE = {
  행정기관명: '가상공공지원재단',
  수신: '수신자 참조',
  경유: '',
  제목: '2026년 3분기 사업 실적 제출 요청',
  본문: '1. 관련: 기획팀-1234(2026. 10. 1.)\n2. 2026년 3분기 사업 실적을 붙임 양식에 따라 2026. 10. 30.(금)까지 제출하여 주시기 바랍니다.\n3. 제출 자료는 부서별 예산액·집행액·참여자 수를 포함하여야 합니다.',
  붙임: '1. 실적 제출 양식 1부.\n2. 작성 요령 1부.  끝.',
  발신명의: '가상공공지원재단 이사장',
  공개구분: '공개',
  작성일: '2026. 10. 27.',
  작성부서: '기획팀',
  개요: '○ 2026년 3분기 부서별 사업 실적을 취합하여 보고함\n○ 운영팀 미제출로 잠정 집계임',
  '추진 경과': '○ 10. 1. 실적 제출 요청\n○ 10. 20. 3개 부서 제출 완료',
  '주요 내용': '○ 예산 2,600,000원 중 1,850,000원 집행(집행률 71.15%)\n○ 참여자 62명',
  '향후 계획': '○ 운영팀 자료 제출 후 확정 집계\n○ 4분기 집행 계획 수립',
  '건의 사항': '○ 해당 없음',
  회의명: '3분기 사업 점검 회의',
  일시: '2026. 10. 27.(화) 14:00',
  장소: '본관 2층 회의실',
  주관: '기획팀',
  참석자: '기획팀장, 사업팀장, 교육팀장',
  안건: '1. 3분기 실적 점검\n2. 4분기 계획',
  '논의 내용': '○ 집행률이 낮은 사업 원인 확인\n○ 미제출 부서 독려 방안',
  '결정 사항': '○ 운영팀 자료 10. 30.까지 제출',
  작성자: '기획팀 주무관',
};

const verificationPath = path.join(BUILTIN_TEMPLATE_DIR, 'verification.json');
const ledger = existsSync(verificationPath) ? JSON.parse(readFileSync(verificationPath, 'utf8')) : { note: '', records: [] };
ledger.note =
  '기본 양식 실제 한글 검증 기록. hancom-automation = scripts/work-template-verify.mjs(한글 COM 자동화로 열기·넣은 글 확인·편집·다시 저장·다시 열기·PDF). human-visual = 사람이 PDF/한글 화면으로 쪽 배치·글꼴·잘림을 본 기록(직접 더한다).';
let failed = 0;

for (const t of BUILTIN_TEMPLATES) {
  const file = path.join(BUILTIN_TEMPLATE_DIR, t.file);
  if (!existsSync(file)) {
    console.log(`✗ ${t.file} 없음`);
    failed += 1;
    continue;
  }
  const bytes = readFileSync(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const read = await readTemplate(bytes, t.file);
  if (!read.ok) {
    console.log(`✗ ${t.file} 읽기 실패: ${read.reason}`);
    failed += 1;
    continue;
  }
  const values = read.slots.map((s) => ({ slot_id: s.id, text: SAMPLE[s.label] ?? `${s.label} 예시` }));
  const filled = await fillTemplate(bytes, t.file, values);
  if (!filled.ok) {
    console.log(`✗ ${t.file} 채우기 실패: ${filled.reason}`);
    failed += 1;
    continue;
  }
  const filledPath = path.join(outDir, t.file.replace('.hwpx', '.filled.hwpx'));
  writeFileSync(filledPath, filled.bytes);
  // 한글이 실제로 보여 주는 글로 확인한다 — 여러 줄 값은 첫 줄과 마지막 줄을 따로 본다
  const expect = [...new Set(values.flatMap((v) => v.text.split('\n').filter((l) => l.trim()).filter((_, i, a) => i === 0 || i === a.length - 1)))];
  const expectFile = path.join(outDir, t.file.replace('.hwpx', '.expect.json'));
  writeFileSync(expectFile, JSON.stringify(expect));
  const ps = spawnSync('powershell', ['-NoProfile', '-File', path.join('scripts', 'hancom-verify.ps1'), '-InputPath', filledPath, '-OutDir', outDir, '-ExpectFile', expectFile], {
    encoding: 'utf8',
    timeout: 180_000,
  });
  const line = (ps.stdout || '').trim().split('\n').pop() || '{}';
  let r;
  try {
    r = JSON.parse(line);
  } catch {
    r = { ok: false, error: (ps.stderr || ps.stdout || '출력 없음').slice(0, 300) };
  }
  const ok = Boolean(r.ok);
  if (!ok) failed += 1;
  console.log(`${ok ? '✓' : '✗'} ${t.file} — 열기 ${r.opened ? '○' : '×'} · 넣은 글 ${r.expectMissing?.length ? `빠짐 ${r.expectMissing.join(', ')}` : '○'} · 편집·다시 저장 ${r.editKept ? '○' : '×'} · PDF ${r.pages ?? 0}쪽${r.error ? ` · 오류 ${r.error}` : ''}`);
  // 자동 검증 기록은 지금 파일 것 하나만 둔다(옛 판 파일의 기록은 의미가 없다). 사람의 시각 검토 기록은 건드리지 않는다
  ledger.records = ledger.records.filter((x) => !(x.file === t.file && x.kind === 'hancom-automation'));
  ledger.records.push({
    file: t.file,
    sha256,
    kind: 'hancom-automation',
    result: ok ? 'passed' : 'failed',
    application: r.application ?? 'Hancom',
    checkedAt: r.checkedAt ?? new Date().toISOString(),
    checks: { opened: r.opened, valuesVisible: !r.expectMissing?.length, editSavedReopened: r.editKept, pdfPages: r.pages },
    filledSha256: createHash('sha256').update(filled.bytes).digest('hex'),
  });
}

writeFileSync(verificationPath, JSON.stringify(ledger, null, 2) + '\n');
console.log(`\n채운 파일·PDF: ${outDir}`);
if (failed) process.exit(1);
