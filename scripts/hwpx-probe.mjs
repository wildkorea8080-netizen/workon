/**
 * 한글·Word 호환 확인용(설계 10절 '확인 작업').
 *
 *   npm run hwpx:probe -- 입력.hwpx 출력.hwpx
 *   npm run hwpx:probe -- 입력.docx 출력.docx
 *   npm run hwpx:probe -- 입력.hwp  출력.hwpx [표준보고서.hwpx]
 *
 * 실제 능력과 같은 입구(readTemplate·fillTemplate)를 거친다 — 표시·자동 자리·DOCX·대체 경로를 모두 본다.
 * 읽은 방식(mode)·이유·자리(id·이름·hint)를 찍고, 자리마다 '[s1 이름] 예시 문장'을 넣어 새 파일을 만든다.
 * 첫 자리는 두 줄이라 새 문단 잇기도 함께 본다.
 *
 * 출력 파일을 한글(또는 Word)에서 열어 (1) 열리는지 (2) 넣은 글이 양식 서식대로 제자리에 보이는지
 * (3) 둘째 줄이 새 문단으로 나뉘었는지 (4) 저장 뒤 다시 열리는지 본다.
 *
 * 대체 경로는 표준 보고서(assets/templates/report.hwpx)가 있어야 채울 수 있다. 셋째 인자로 다른 파일을 줄 수 있다.
 */
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { readTemplate, fillTemplate } from '../src/lib/doc-fill/index.ts';
import { findBuiltinTemplate, loadBuiltinTemplate } from '../src/lib/builtin-templates.ts';

const [input, output, reportPath] = process.argv.slice(2);
if (!input || !output) {
  console.error('사용법: npm run hwpx:probe -- 입력(.hwpx|.hwp|.docx) 출력 [표준보고서.hwpx]');
  process.exit(1);
}

const name = path.basename(input);
const bytes = readFileSync(input);
const read = await readTemplate(bytes, name);
if (!read.ok) {
  console.error(`읽기 실패: ${read.reason}`);
  process.exit(1);
}

console.log(`방식 ${read.mode} · 만들 형식 ${read.format}`);
if (read.reason) console.log(`이유: ${read.reason}`);
console.log(`자리 ${read.slots.length}개`);
for (const s of read.slots) {
  const where = s.path.length > 0 ? ` (위: ${s.path.join(' > ')})` : '';
  const hint = s.hint ? ` — hint: ${s.hint}` : '';
  console.log(`  ${s.id} [${s.kind}] ${s.label}${where}${hint}`);
}

let fallbackTemplate = null;
if (read.mode === 'fallback') {
  fallbackTemplate = reportPath ? readFileSync(reportPath) : await loadBuiltinTemplate(findBuiltinTemplate('builtin:report'));
  if (!fallbackTemplate) {
    console.error('대체 경로는 표준 서식(assets/templates/report.hwpx)이 있어야 확인할 수 있습니다. 파일을 두거나 셋째 인자로 주세요.');
    process.exit(1);
  }
}

const values = read.slots.map((s, i) => ({
  slot_id: s.id,
  text:
    i === 0
      ? `[${s.id} ${s.label}] 예시 문장 & 특수문자 <확인>\n둘째 줄 — 새 문단이어야 합니다`
      : `[${s.id} ${s.label}] 예시 문장`,
}));
const result = await fillTemplate(bytes, name, values, { title: '확인용 문서', fallbackTemplate });
if (!result.ok) {
  console.error(`채우기 실패: ${result.reason}`);
  process.exit(1);
}

// 결과 형식과 출력 이름의 확장자가 다르면 맞는 확장자로 바꿔 쓴다(DOCX·대체 경로는 형식이 바뀔 수 있다)
let target = output;
const ext = path.extname(output).slice(1).toLowerCase();
if (ext !== result.extension) {
  target = `${output.slice(0, output.length - path.extname(output).length)}.${result.extension}`;
  console.warn(`주의: 결과는 ${result.extension} 파일입니다. ${output} 대신 ${target}에 씁니다.`);
}
writeFileSync(target, result.bytes);

console.log(`채움 ${result.filled.length}개 · 못 채움 ${result.unfilled.length}개`);
const app = result.extension === 'docx' ? 'Word' : '한글';
const note = result.mode === 'fallback' ? " (대체 경로: 표준 보고서의 '주요 내용' 아래에 항목 순서대로 들어갑니다)" : '';
console.log(`→ ${target} 를 ${app}에서 열어 확인하세요.${note}`);
