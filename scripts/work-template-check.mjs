/**
 * 기본 양식 준비 상태 점검 (WORKON 개편 P0).
 *
 *   npm run work:template-check            -- 보기만(없으면 '준비 안 됨'으로 찍고 0으로 끝남)
 *   npm run work:template-check -- --release  -- 출시 관문: 하나라도 못 갖추면 1로 끝남
 *
 * 양식마다 본다:
 *   1. 파일이 있는가 (assets/templates/*.hwpx)
 *   2. 한글이 쓴 HWPX 꼴인가 (zip·mimetype·Contents/section) — 이름만 바꾼 파일을 거른다
 *   3. 설계 표시({{이름}})를 다 갖췄는가 (builtin-templates.ts의 markers)
 *   4. 채우기 엔진이 '표시' 방식으로 읽는가 (readTemplate → mode fill, kind marker)
 *   5. 이 파일(SHA-256)로 한 한글 실제 검증 기록이 있는가 (assets/templates/verification.json)
 *      — 자동 검증(열기·편집·다시 저장·PDF, scripts/hancom-verify.ps1)과 사람의 시각 검토를 따로 본다
 *
 * --release는 1~5 전부 + 사람의 시각 검토 통과를 요구한다. 개발 테스트(npm test)는 이 스크립트에 묶지 않는다.
 */
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import JSZip from 'jszip';
import { readTemplate } from '../src/lib/doc-fill/index.ts';
import { readHwpxMarkers } from '../src/lib/doc-fill/hwpx.ts';
import { BUILTIN_TEMPLATES, BUILTIN_TEMPLATE_DIR } from '../src/lib/builtin-templates.ts';

const release = process.argv.includes('--release');
const verificationPath = path.join(BUILTIN_TEMPLATE_DIR, 'verification.json');
const records = existsSync(verificationPath) ? JSON.parse(readFileSync(verificationPath, 'utf8')).records ?? [] : [];

async function packageShape(bytes) {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const mimetype = zip.file('mimetype') ? (await zip.file('mimetype').async('string')).trim() : null;
    const sections = Object.keys(zip.files).filter((n) => /^Contents\/section\d+\.xml$/.test(n));
    return { zip: true, mimetype, sections: sections.length };
  } catch {
    return { zip: false, mimetype: null, sections: 0 };
  }
}

let failures = 0;
for (const t of BUILTIN_TEMPLATES) {
  const file = path.join(BUILTIN_TEMPLATE_DIR, t.file);
  const problems = [];
  const warnings = [];
  if (!existsSync(file)) {
    console.log(`✗ ${t.file} — 파일 없음 (한글로 만든 HWPX를 assets/templates/에 둔다: assets/templates/README.md)`);
    failures += 1;
    continue;
  }
  const bytes = readFileSync(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const shape = await packageShape(bytes);
  if (!shape.zip) problems.push('zip이 아님');
  if (shape.mimetype !== 'application/hwp+zip') problems.push(`mimetype ${shape.mimetype ?? '없음'}`);
  if (shape.sections === 0) problems.push('Contents/section*.xml 없음');

  const found = shape.zip ? await readHwpxMarkers(bytes).catch(() => []) : [];
  const missing = t.markers.filter((m) => !found.includes(m));
  if (missing.length) problems.push(`표시 없음: ${missing.join(', ')}`);
  const read = await readTemplate(bytes, t.file);
  if (!read.ok) problems.push(`엔진이 읽지 못함: ${read.reason}`);
  else if (read.mode !== 'fill' || read.slots[0]?.kind !== 'marker') problems.push(`엔진 방식 ${read.mode}/${read.slots[0]?.kind}`);

  const mine = records.filter((r) => r.file === t.file && r.sha256 === sha256);
  const auto = mine.find((r) => r.kind === 'hancom-automation' && r.result === 'passed');
  const human = mine.find((r) => r.kind === 'human-visual' && r.result === 'passed');
  if (!auto) problems.push('이 파일(SHA-256)의 한글 자동 검증 기록 없음 — scripts/hancom-verify.ps1');
  if (!human) (release ? problems : warnings).push('사람의 시각 검토 기록 없음(쪽 배치·글꼴·잘림)');

  const status = problems.length ? '✗' : '✓';
  if (problems.length) failures += 1;
  console.log(`${status} ${t.file} sha256=${sha256.slice(0, 12)}… 표시 ${found.length}/${t.markers.length}${auto ? ` · 자동 검증 ${auto.application} ${auto.checkedAt.slice(0, 10)}` : ''}`);
  for (const p of problems) console.log(`    문제: ${p}`);
  for (const w of warnings) console.log(`    주의: ${w}`);
}

if (failures) {
  console.log(`\n준비 안 된 양식 ${failures}개${release ? ' — 출시 관문 실패' : ' (보기만 — 출시 관문은 --release)'}`);
  if (release) process.exit(1);
} else {
  console.log('\n기본 양식 모두 준비됨');
}
