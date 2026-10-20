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

/**
 * 괄호 속 글이 단위로 보이는가 — '단위' 표기가 있거나, 숫자 없는 짧은 글('냥', '만원').
 * 이런 괄호가 있는데 모르는 단위라면 열 이름이 이미 단위를 말한 것이다.
 * 그때 캡션의 다른 단위로 넘어가면 이 열에 엉뚱한 단위가 붙는다. '(참고)'도 짧아 막지만 null은 안전한 쪽이다
 */
function looksLikeUnit(inner: string): boolean {
  if (UNIT_LABEL.test(inner)) return true;
  return inner.length > 0 && inner.length <= 4 && !/\d/.test(inner);
}

/**
 * 열 이름의 괄호: '예산(천원)', '예산 (단위: 천원)', 전각·대괄호도.
 * 단위가 아닌 괄호('(2025년 기준)')는 건너뛴다. 단위로 보이는데 모르는 괄호만 있으면 blocked.
 * 알려진 단위가 서로 다르게 둘이면 어느 쪽인지 몰라 unit=null, blocked=true.
 */
function unitFromColumnName(name: string): { unit: string | null; blocked: boolean } {
  const units = new Set<string>();
  let unknown = false;
  for (const m of name.matchAll(/[(（\[]([^()（）\[\]]*)[)）\]]/g)) {
    const inner = m[1].trim();
    const unit = normalizeUnit(inner.replace(UNIT_LABEL, ''));
    if (unit) units.add(unit);
    else if (looksLikeUnit(inner)) unknown = true;
  }
  if (units.size === 1) return { unit: [...units][0], blocked: false };
  return { unit: null, blocked: units.size > 1 || unknown };
}

/** 단위가 여럿 나열된 표기('천원, 명')는 어느 열 것인지 알 수 없다 */
const LIST_SEPARATOR = /[,，、·\/]/;

/** 단위 절 하나의 글('천원', '천 원 연도별 예산')에서 알려진 단위. 앞쪽 낱말 1~3개를 이어 본다('천 원'은 두 낱말) */
function resolveClause(segment: string): string | null {
  const text = segment.trim().replace(/^[:：]\s*/, '');
  if (LIST_SEPARATOR.test(text)) return null;
  const words = text.split(/\s+/);
  for (let take = 1; take <= Math.min(3, words.length); take += 1) {
    const unit = normalizeUnit(words.slice(0, take).join(' '));
    if (unit) return unit;
  }
  return null;
}

/**
 * 단위 절: 'ㅇㅇ: 천원' 꼴(`단위:`·`단위 :`) 또는 괄호 속 '(단위 천원)'.
 * 문장 속 '단위 건 처리 현황'은 절이 아니다 — 콜론도 괄호도 없으면 단위 표기가 아니라 낱말이다
 */
const UNIT_CLAUSE = /단위\s*[:：]\s*([^()（）\[\]<>\n]+)|[(（]\s*단위\s+(?![:：])([^()（）]+)[)）]/g;

/**
 * 캡션의 단위. 절이 하나도 없으면 null, 절마다 정한 단위가 모두 같을 때만 그 단위
 * (표 두 장 캡션이 한 글에 붙은 '(단위: 천원) (단위: 명)'은 어느 열 것인지 몰라 null)
 */
function unitFromCaption(caption: string): string | null {
  const resolved = new Set<string | null>();
  for (const m of caption.matchAll(UNIT_CLAUSE)) resolved.add(resolveClause(m[1] ?? m[2]));
  if (resolved.size !== 1) return null;
  return [...resolved][0];
}

export function columnUnit(input: ColumnUnitInput): string | null {
  const fromCells = unitFromCells(input.cells);
  if (fromCells) return fromCells;
  // 열 이름이 단위를 말했으나 모르는 단위면 거기서 멈춘다 — 캡션으로 넘어가면 엉뚱한 단위가 붙는다
  const fromName = unitFromColumnName(input.columnName);
  if (fromName.unit || fromName.blocked) return fromName.unit;
  return input.caption ? unitFromCaption(input.caption) : null;
}
