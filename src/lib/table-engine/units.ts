/**
 * 열의 단위 찾기. 순서: 칸에 적힌 단위의 과반 → 열 이름의 괄호 → 캡션의 '단위' 표기.
 * 못 찾으면 null — 단위를 지어내지 않는다(RAG의 '2,000톤' 사례와 같은 이유).
 */
import { parseNumber } from './number';
import { normalizeUnit } from './unit-names';

export { KNOWN_UNITS, normalizeUnit } from './unit-names';

export interface ColumnUnitInput {
  columnName: string;
  caption?: string;
  cells: (string | number | null)[];
}

/** 값으로 읽히는 칸 중 같은 단위가 절반을 넘는 것. 단위 없는 숫자 칸도 분모에 든다 */
function unitFromCells(cells: (string | number | null)[]): string | null {
  const counts = new Map<string, number>();
  let numbers = 0;
  for (const cell of cells) {
    const p = parseNumber(cell);
    if (p.kind !== 'number') continue;
    numbers += 1;
    if (p.unit) counts.set(p.unit, (counts.get(p.unit) ?? 0) + 1);
  }
  for (const [unit, n] of counts) if (n * 2 > numbers) return unit;
  return null;
}

/** '단위:' 머리와 앞뒤 공백을 뗀 괄호 속 글 */
const UNIT_LABEL = /^단위\s*[:：]?\s*/;

/** 열 이름의 괄호: '예산(천원)', '예산 (단위: 천원)', 전각·대괄호도. 단위가 아닌 괄호('(참고)')는 건너뛴다 */
function unitFromColumnName(name: string): string | null {
  for (const m of name.matchAll(/[(（\[]([^()（）\[\]]*)[)）\]]/g)) {
    const unit = normalizeUnit(m[1].trim().replace(UNIT_LABEL, ''));
    if (unit) return unit;
  }
  return null;
}

/** 단위가 여럿 나열된 표기('천원, 명')는 어느 열 것인지 알 수 없다 */
const LIST_SEPARATOR = /[,，、·\/]/;

/**
 * 캡션의 '단위' 표기: '(단위: 천원)', '단위 : 천 원', '단위：천원 연도별 예산'.
 * '단위' 뒤 글에서 앞쪽 낱말 1~3개를 이어 알려진 단위가 되는 첫 조합을 쓴다('천 원'은 두 낱말).
 */
function unitFromCaption(caption: string): string | null {
  for (const m of caption.matchAll(/단위\s*[:：]?\s*([^()（）\[\]<>\n]+)/g)) {
    const segment = m[1].trim();
    if (LIST_SEPARATOR.test(segment)) return null;
    const words = segment.split(/\s+/);
    for (let take = 1; take <= Math.min(3, words.length); take += 1) {
      const unit = normalizeUnit(words.slice(0, take).join(' '));
      if (unit) return unit;
    }
  }
  return null;
}

export function columnUnit(input: ColumnUnitInput): string | null {
  return (
    unitFromCells(input.cells) ??
    unitFromColumnName(input.columnName) ??
    (input.caption ? unitFromCaption(input.caption) : null)
  );
}
