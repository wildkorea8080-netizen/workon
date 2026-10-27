/**
 * 기본 양식 실제 한글 검증 (WORKON 개편 P0) — Windows + 한글 설치 PC에서만 돈다.
 *
 *   npm run work:template-verify            -- 세 양식을 채워 한글에서 열기·편집·다시 저장·PDF, 기록 남김
 *   npm run work:template-verify -- --out 폴더  -- 채운 파일·PDF를 그 폴더에 둔다(기본: 임시 폴더)
 *   npm run work:template-verify -- --only regulation_memo  -- 한 양식만(다른 양식의 기록은 그대로 둔다)
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
  '검토 질문': '출장 중 숙박비가 상한을 넘으면 차액을 지급할 수 있는가',
  '적용 기준': '적용 기준일 2026. 10. 27. · 범위: 국내 출장 여비',
  '검토 의견': '○ 숙박비는 상한액 범위에서 실비로 지급하는 것이 원칙임[E1]\n○ 상한을 넘는 차액 지급의 예외 요건은 확인한 근거에서 찾지 못해 유보함',
  근거: '[E1] 여비 규정 · p.12 · 제3장 › 숙박비 (기관 문서, 시행일 확인 필요)\n[E2] 공무원 여비 규정 제17조 (법령, 시행 2026. 1. 1.)',
  '유보·확인 필요': '○ 상한 초과 차액 지급의 예외 요건 — 근거 없음',
  '검토 범위': '확인한 자료: 기관 문서 1건 · 법령 1건. 법률적 최종 판단이 아닙니다.',
  '작성 기준일': '2026-10-27',
  인계자: '기획팀 주무관 김가나',
  인수자: '기획팀 주무관 이다라',
  확인자: '기획팀장',
  '업무 개요': '○ 분기별 사업 실적 취합·보고와 위원회 운영을 맡음',
  '진행 중 업무': '○ 3분기 실적 취합 — 운영팀 자료 대기 (운영팀 / 2026-10-30)',
  '미결 과제': '○ 4분기 집행 계획 수립 — 부서 의견 수렴 중 (기획팀장)',
  '완료 업무': '○ 2분기 실적 보고 — 2026. 7. 15. 보고 완료',
  '반복 일정': '○ 분기 실적 취합 (매 분기 말 10일 전)',
  '참고 자료': '○ 분기 실적 취합 매뉴얼(공유 폴더)',
  '유의 사항': '○ 비밀번호·계정 정보는 적지 않음 — 시스템 권한은 별도 신청',
};

const verificationPath = path.join(BUILTIN_TEMPLATE_DIR, 'verification.json');
const ledger = existsSync(verificationPath) ? JSON.parse(readFileSync(verificationPath, 'utf8')) : { note: '', records: [] };
ledger.note =
  '기본 양식 실제 한글 검증 기록. hancom-automation = scripts/work-template-verify.mjs(한글 COM 자동화로 열기·넣은 글 확인·편집·다시 저장·다시 열기·PDF). human-visual = 사람이 PDF/한글 화면으로 쪽 배치·글꼴·잘림을 본 기록(직접 더한다).';
let failed = 0;

const onlyIdx = process.argv.indexOf('--only');
const only = onlyIdx > 0 ? process.argv[onlyIdx + 1] : null;

for (const t of BUILTIN_TEMPLATES.filter((x) => !only || x.file === only || x.ref === only || x.file === `${only}.hwpx`)) {
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
