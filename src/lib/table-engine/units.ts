/**
 * 열의 단위 찾기. 순서: 칸에 적힌 단위의 과반 → 열 이름의 괄호 → 캡션의 '단위' 표기.
 * 못 찾으면 null — 단위를 지어내지 않는다(RAG의 '2,000톤' 사례와 같은 이유).
 * 캡션의 단위는 표 전체에 쓰인 글이라 열마다 맞는지 따로 본다(nameDimension) — '(단위: 천원)' 표의 '인원' 열은 천원이 아니다.
 */
import { parseNumber } from './number';
import { normalizeUnit, unitDimension } from './unit-names';

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

/** 단위가 여럿 나열된 표기('천원, 명')는 어느 열 것인지 알 수 없다 */
const LIST_SEPARATOR = /[,，、·\/]/;

/** 단위·수량을 뜻하는 글자. '(국비)'·'(본예산)' 같은 구분 표기와 가르는 근거 */
const UNIT_CHARS = /[원명건톤㎡개회대천만억조%㎏㏊㎞㎥]|kg|ha|km/i;

/**
 * 괄호 속 글이 단위로 보이는가 — '단위' 표기가 있거나, 알려진 단위(별칭 포함)이거나, 단위·수량 글자가 든 글.
 * 이런 괄호가 있는데 모르는 단위라면('(천냥)') 열 이름이 이미 단위를 말한 것이다.
 * 그때 캡션의 다른 단위로 넘어가면 이 열에 엉뚱한 단위가 붙는다.
 * 글자가 없는 짧은 괄호('(국비)'·'(추경)'·'(A)')는 구분 표기라 막지 않는다
 */
function looksLikeUnit(inner: string): boolean {
  return UNIT_LABEL.test(inner) || normalizeUnit(inner) !== null || UNIT_CHARS.test(inner);
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
    const body = inner.replace(UNIT_LABEL, '');
    if (LIST_SEPARATOR.test(body)) {
      // 나열('천원, 명')은 어느 쪽인지 몰라 막는다. 단위가 하나도 없는 나열('국비, 시비')은 구분 표기
      if (body.split(LIST_SEPARATOR).some((part) => normalizeUnit(part) !== null)) unknown = true;
      continue;
    }
    const unit = normalizeUnit(body);
    if (unit) units.add(unit);
    else if (looksLikeUnit(inner)) unknown = true;
  }
  if (units.size === 1 && !unknown) return { unit: [...units][0], blocked: false };
  return { unit: null, blocked: units.size > 0 || unknown };
}

/** 단위 절 하나의 글('천원', '천 원 연도별 예산')에서 알려진 단위. 앞쪽 낱말을 이어 본다.
 * 긴 조합이 먼저다 — '억 명'은 '억원'(맨 '억')이 아니라 '억명'이어야 한다 */
function resolveClause(segment: string): string | null {
  const text = segment.trim().replace(/^[:：]\s*/, '');
  if (LIST_SEPARATOR.test(text)) return null;
  const words = text.split(/\s+/);
  for (let take = Math.min(3, words.length); take >= 1; take -= 1) {
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

export type UnitSource = 'cell' | 'name' | 'caption';

/**
 * 열 이름의 차원 낱말. 앞 순서가 먼저다 — '집행률'은 돈이 아니라 비율, '예산 건수'는 돈이 아니라 건.
 * 한 글자 낱말(율·률·건·명·액·비·료)은 이름 끝에서만 본다 — '비고'·'명칭'·'건물'을 잘못 잡지 않게.
 * 괄호 속('예산(국비, 시비)')은 보지 않는다
 */
const DIMENSION_WORDS: { dimension: string; words: string[]; suffixes: string[] }[] = [
  { dimension: '비율', words: ['비율', '비중', '점유'], suffixes: ['율', '률'] },
  { dimension: '건', words: ['건수'], suffixes: ['건'] },
  { dimension: '개', words: ['개수', '수량', '개소'], suffixes: [] },
  { dimension: '사람', words: ['인원', '직원', '정원', '현원'], suffixes: ['명'] },
  { dimension: '돈', words: ['금액', '예산', '원가', '단가', '수입', '지출', '매출', '집행'], suffixes: ['액', '비', '료'] },
];

/**
 * '…대비'는 비교 기준이 무엇이냐에 따라 금액·비율·배수가 다 된다 — 차원을 모르니 캡션 단위를 붙이지 않는다('모름').
 * '…수'(학생수·가구수·횟수)는 셈이다 — 돈·% 캡션은 붙지 않고 명·가구·회 같은 캡션은 붙는다('수').
 * 낱말 목록이 먼저다 — '인원수'는 사람, '개소수'는 개, '수수료'는 돈
 */
export function nameDimension(columnName: string): string | null {
  const name = columnName.replace(/[(（[][^()（）[\]]*[)）\]]/g, '').replace(/\s+/g, '');
  const endsWithDaebi = name.endsWith('대비');
  for (const d of DIMENSION_WORDS) {
    // '전년대비'의 끝 '비'는 경비의 비가 아니다
    const suffixes = endsWithDaebi ? d.suffixes.filter((w) => w !== '비') : d.suffixes;
    if (d.words.some((w) => name.includes(w)) || suffixes.some((w) => name.endsWith(w))) return d.dimension;
  }
  if (name.includes('대비')) return '모름';
  if (name.endsWith('수')) return '수';
  return null;
}

/** 열 이름 차원에 캡션 단위가 맞는가 */
function captionFits(nameDim: string, unitDim: string): boolean {
  if (nameDim === '모름') return false;
  if (nameDim === '수') return unitDim !== '돈' && unitDim !== '비율';
  return nameDim === unitDim;
}

export function columnUnitInfo(input: ColumnUnitInput): { unit: string; source: UnitSource } | null {
  const fromCells = unitFromCells(input.cells);
  if (fromCells) return { unit: fromCells, source: 'cell' };
  // 열 이름이 단위를 말했으나 모르는 단위면 거기서 멈춘다 — 캡션으로 넘어가면 엉뚱한 단위가 붙는다
  const fromName = unitFromColumnName(input.columnName);
  if (fromName.unit) return { unit: fromName.unit, source: 'name' };
  if (fromName.blocked || !input.caption) return null;
  const fromCaption = unitFromCaption(input.caption);
  if (!fromCaption) return null;
  // 이름이 다른 차원을 말하면(인원 ↔ 천원) 캡션 단위는 이 열 것이 아니다. 차원 낱말이 없으면 캡션을 따른다
  const dimension = nameDimension(input.columnName);
  if (dimension && !captionFits(dimension, unitDimension(fromCaption))) return null;
  return { unit: fromCaption, source: 'caption' };
}

export function columnUnit(input: ColumnUnitInput): string | null {
  return columnUnitInfo(input)?.unit ?? null;
}
