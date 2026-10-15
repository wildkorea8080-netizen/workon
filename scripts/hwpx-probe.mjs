/**
 * 한글 호환 확인용(설계 10절 '확인 작업').
 *
 *   npm run hwpx:probe -- 입력.hwpx 출력.hwpx
 *
 * 한글이 저장한 HWPX에 엔진으로 글을 넣어 새 파일을 만든다. 출력 파일을
 * 한글에서 열어 (1) 열리는지 (2) 넣은 글이 양식 서식대로 보이는지
 * (3) 둘째 줄이 새 문단으로 나뉘었는지 (4) 저장 뒤 다시 열리는지 본다.
 * 양식에는 {{제목}}처럼 표시를 넣어 둔다.
 */
import { readFileSync, writeFileSync } from 'fs';
import { readHwpxMarkers, fillHwpx } from '../src/lib/doc-fill/hwpx.ts';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('사용법: npm run hwpx:probe -- 입력.hwpx 출력.hwpx');
  process.exit(1);
}

const bytes = readFileSync(input);
const labels = await readHwpxMarkers(bytes);
if (labels.length === 0) {
  console.error('표시({{항목}})를 찾지 못했습니다. 양식에 {{제목}} 같은 표시를 넣어 저장해 주세요.');
  process.exit(1);
}

const values = new Map(
  labels.map((label) => [label, `[${label}] 시험으로 넣은 첫 줄 & 특수문자 <확인>\n둘째 줄 — 새 문단이어야 합니다`])
);
const result = await fillHwpx(bytes, values);
writeFileSync(output, result.bytes);

console.log(`표시 ${labels.length}개: ${labels.join(', ')}`);
console.log(`채움 ${result.filled.length}개 · 못 채움 ${result.unfilled.length}개`);
console.log(`→ ${output} 를 한글에서 열어 확인하세요.`);
