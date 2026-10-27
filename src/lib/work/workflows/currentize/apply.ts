// src/lib/work/workflows/currentize/apply.ts
// 현행화 — 변경 계획을 작년 HWPX 바이트에 글자 단위로 적용한다(S6-1).
// 있는 문단의 글만 바꾸고, 여러 줄이면 그 문단 바로 뒤에 글만 든 새 문단을 잇는다. 표 행·구역은 넣지도 빼지도 않는다.
// 편집 방식은 양식 채우기(doc-fill/hwpx.ts planParagraph)와 같다 — 한글이 받아 주는 것이 검증된 길이다.
import {
  openHwpx,
  readEntry,
  scanParagraphs,
  textXml,
  pieceOffsets,
  freshParagraph,
  valueLines,
  dedupeDeletes,
  applyEdits,
  ancestorLineSegDeletes,
  writeHwpx,
  type Para,
  type Edit,
} from '@/lib/doc-fill/hwpx-core';
import { paragraphPrefix } from '@/lib/doc-fill/xml-scan';
import { parseNumber } from '@/lib/table-engine/number';
import { WorkError } from '@/lib/work/types';
import { scanSegmentParas } from './segments';
import { isNoopChange, type Change } from './plan';

/** 앞자리 0 없는 `섹션:위치` — '0:010'이 '0:10'과 같은 문단을 가리키는 다른 글이 되지 않게 */
const SEGMENT_ID = /^(0|[1-9]\d*):(0|[1-9]\d*)$/;

function priorMismatch(): WorkError {
  return new WorkError('PRIOR_MISMATCH', '작년 파일이 바뀌어 변경을 적용할 수 없습니다.', 409);
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** 같은 앞부분·뒷부분의 길이(코드 단위). 서로게이트 쌍을 가르지 않고, 둘이 겹치지 않는다 */
function commonEnds(a: string, b: string): { prefix: number; suffix: number } {
  const max = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < max && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;
  // 높은 서로게이트에서 멈췄으면 쌍이 갈린 것이다 — 한 칸 물린다
  if (prefix > 0 && isHigh(a.charCodeAt(prefix - 1))) prefix--;
  let suffix = 0;
  while (suffix < max - prefix && a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)) suffix++;
  if (suffix > 0 && isLow(a.charCodeAt(a.length - suffix))) suffix--;
  return { prefix, suffix };
}

/**
 * 문단 글을 first로 바꾸는 가장 작은 편집. 같은 앞·뒷부분은 두고 바뀐 가운데만 조각에 얹는다 —
 * 조각 사이의 탭·줄바꿈·컨트롤이 제자리에 남는다(통째로 첫 조각에 넣으면 '□<탭>2025년'이 '□2026년<탭>'이 된다).
 * 바뀐 범위에 걸친 첫 조각이 새 가운데 글을 모두 받고, 걸친 다른 조각은 걸친 부분만 잃는다.
 * 넣기만 하는 변경(옛 가운데가 빔)은 그 자리에서 시작하는 조각 — 경계면 **뒤 조각**(탭·컨트롤 뒤) — 에 넣는다
 * ('1.<탭>사업' → '1.<탭>신규 사업'). 문단 끝이면 뒤 조각이 없으니 마지막 조각에.
 */
function textEdits(para: Para, first: string): Edit[] {
  const old = para.text;
  if (old === first) return [];
  const { prefix, suffix } = commonEnds(old, first);
  const from = prefix;
  const to = old.length - suffix;
  const middle = first.slice(prefix, first.length - suffix);
  const offsets = pieceOffsets(para);
  const texts = para.pieces.map((p) => p.text);

  let placed = false;
  for (let i = 0; i < para.pieces.length; i++) {
    const pStart = offsets[i];
    const pEnd = pStart + texts[i].length;
    const last = i === para.pieces.length - 1;
    const hit = from < to ? pEnd > from && pStart < to : (pStart <= from && from < pEnd) || (last && from === pEnd);
    if (!hit) continue;
    const localStart = Math.max(from, pStart) - pStart;
    const localEnd = Math.min(to, pEnd) - pStart;
    texts[i] = texts[i].slice(0, localStart) + (placed ? '' : middle) + texts[i].slice(localEnd);
    placed = true;
    if (from === to) break;
  }

  const edits: Edit[] = [];
  para.pieces.forEach((p, i) => {
    if (texts[i] !== p.text) edits.push({ start: p.start, end: p.end, text: textXml(texts[i]) });
  });
  return edits;
}

/** 문단 하나를 after로: 바뀐 부분만 고치고, 둘째 줄부터는 뒤에 새 문단. 무엇이든 바뀌면 줄 배치 캐시를 지운다 */
function paragraphEdits(para: Para, after: string, prefix: string): Edit[] {
  const lines = valueLines(after);
  const edits = textEdits(para, lines[0]);
  const extras = lines
    .slice(1)
    .map((line) => freshParagraph(para.openTag, para.pieces[0].charPr, line, prefix))
    .join('');
  if (extras) edits.push({ start: para.end, end: para.end, text: extras });
  if (edits.length === 0) return [];
  // 글이 바뀐 문단의 줄 배치 캐시를 지운다. 남으면 한글이 옛 배치로 겹쳐 그릴 수 있다
  for (const seg of para.lineSegs) edits.push({ start: seg.start, end: seg.end, text: '' });
  return edits;
}

const squash = (s: string) => s.replace(/\s/g, '');

/**
 * 표 칸의 before는 표 읽기 결과(ShiftedCell.before — 숫자 칸은 '1200'처럼 쉼표 없이 올 수 있다)라 문단 글과 꼴이 다를 수 있다.
 * 공백을 뺀 글이 같거나, 둘 다 숫자로 읽히고 값·단위·백분율 표시가 같아야 같은 칸이다('1200원'과 '1200명'은 다른 칸).
 * 쉼표는 숫자 읽기가 자리(3자리씩)까지 보므로 글 비교에서 지우지 않는다('12,00'은 '1,200'이 아니다).
 * 여러 문단 칸(줄바꿈)은 문단 하나로 쓸 수 없어 받지 않는다.
 */
function sameCell(paraText: string, before: string): boolean {
  if (before.includes('\n')) return false;
  if (squash(paraText) === squash(before)) return true;
  const a = parseNumber(paraText);
  const b = parseNumber(before);
  return a.kind === 'number' && b.kind === 'number' && a.value === b.value && a.unit === b.unit && !!a.percent === !!b.percent;
}

/**
 * status가 changed이고 after가 있는 변경만 적용한다(after가 before 그대로인 '확인함'은 건너뛴다). 위치는 모두 **원래 바이트** 기준이라 한 섹션의 편집을 한 번에 모아 적용한다.
 * 조각 id가 풀리지 않거나 그 문단의 글이 before와 다르면(표 칸은 sameCell로) PRIOR_MISMATCH.
 * 적용할 것이 없으면 원래 바이트를 그대로 돌려준다.
 */
export async function applyChanges(priorBytes: Buffer, changes: Change[]): Promise<Buffer> {
  // 올해 글이 작년 글 그대로인 바꿈('확인함')은 넣을 것이 없다
  const applied = changes.filter((c) => c.status === 'changed' && c.after !== null && !isNoopChange(c));
  if (applied.length === 0) return priorBytes;

  const doc = await openHwpx(priorBytes);
  const bySection = new Map<number, { change: Change; start: number }[]>();
  const seen = new Set<string>();
  for (const change of applied) {
    const m = change.segmentId.match(SEGMENT_ID);
    if (!m) throw priorMismatch();
    const section = Number(m[1]);
    if (section >= doc.sections.length) throw priorMismatch();
    const start = Number(m[2]);
    // 한 문단에 두 변경을 겹쳐 적용하면 XML이 깨진다 — 계획이 그런 목록을 내지 않는다
    const key = `${section}:${start}`;
    if (seen.has(key)) throw new WorkError('INVALID_INPUT', '같은 조각에 적용할 변경이 둘 이상입니다.', 400);
    seen.add(key);
    const list = bySection.get(section);
    if (list) list.push({ change, start });
    else bySection.set(section, [{ change, start }]);
  }

  const edited = new Map<string, string>();
  for (const [section, list] of bySection) {
    const name = doc.sections[section];
    const xml = await readEntry(doc.zip, name);
    const prefix = paragraphPrefix(xml);
    // 조각 id는 readSegments와 같은 훑기로 푼다
    const segmentParas = new Map(scanSegmentParas(xml, prefix).map((p) => [p.start, p]));
    // 표를 품은 바깥 문단은 글이 없어 조각이 아니지만 그 줄 배치 캐시도 지워야 한다 — 모든 문단으로 찾는다
    const byStart = new Map(scanParagraphs(xml, prefix).map((p) => [p.start, p]));

    const edits: Edit[] = [];
    for (const { change, start } of list) {
      const para = segmentParas.get(start);
      if (!para) throw priorMismatch();
      if (change.kind === 'table' ? !sameCell(para.text, change.before) : para.text !== change.before) throw priorMismatch();
      const own = paragraphEdits(para, change.after!, prefix);
      // 표 칸 같은 안쪽 문단이 바뀌면 그것을 품은 문단의 옛 줄 배치(표 높이 포함)도 낡는다
      if (own.length > 0) edits.push(...own, ...ancestorLineSegDeletes(para, byStart));
    }
    const out = applyEdits(xml, dedupeDeletes(edits));
    if (out !== xml) edited.set(name, out);
  }
  // 모두 같은 글이었으면 다시 묶지 않는다 — 원래 바이트 그대로
  if (edited.size === 0) return priorBytes;
  return writeHwpx(doc, edited);
}
