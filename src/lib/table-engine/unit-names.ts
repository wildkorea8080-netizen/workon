/**
 * 알려진 단위와 표기 정리. 아무것도 import하지 않는 잎 파일이다 —
 * number.ts(칸 읽기)와 units.ts(열 단위 찾기)가 서로를 부르는 순환을 막으려고 따로 둔다.
 * 단위를 모르면 null: 모르는 단위를 아는 단위로 짐작하면 합계가 조용히 틀린다.
 */

/** 수량 접두('' = 없음). 표에는 '천명'·'만원'·'백억원'처럼 접두가 단위에 붙어 나온다 */
const QUANTITY_PREFIXES = ['', '천', '만', '백만', '천만', '억', '십억', '백억', '조'];
/** 접두를 붙일 수 있는 기본 단위 */
const BASE_UNITS = ['원', '명', '톤', '㎡', '건', '개', '개소', '회', '대', '가구', 'kg'];
/** 접두 없이 쓰는 단위 */
const STANDALONE_UNITS = ['%', '%p', 'ha', 'km', '㎥', '일', '시간', '년', '개월', '점', '배'];

/**
 * 조합으로 만든 알려진 단위. 접두×기본을 손으로 늘어놓지 않는 이유는 목록이 어긋나
 * '천톤'은 되고 '천㎡'은 안 되는 식의 빈틈이 생기지 않게 하려는 것.
 * 여기 없는 표기('냥' 등)는 값 칸에서 읽지 못함으로 떨어진다
 */
export const KNOWN_UNITS: readonly string[] = [
  ...QUANTITY_PREFIXES.flatMap((p) => BASE_UNITS.map((b) => p + b)),
  ...STANDALONE_UNITS,
];

const KNOWN = new Set(KNOWN_UNITS);

/**
 * 별칭 → 정본. 호환 문자(㎏·㏊·㎞)는 NFKC로 풀면 'm2'처럼 다른 글자가 되므로 낱개로 적는다.
 * 맨 '억'·'조'는 예산표에서 돈이다('25억' = 25억원) — 사람 수나 건수일 가능성은 열 이름·캡션이 정한다
 */
const ALIASES: Record<string, string> = {
  '㎏': 'kg',
  '㏊': 'ha',
  '㎞': 'km',
  '억': '억원',
  '조': '조원',
};

/** 공백(전각·줄바꿈 포함)을 모두 뗀다 — '천 원'과 '천원'이 같은 단위. 영문 단위는 소문자로('Km'→'km') */
export function normalizeUnit(raw: string): string | null {
  const t = raw.replace(/\s+/g, '').toLowerCase();
  const alias = ALIASES[t];
  if (alias) return alias;
  return KNOWN.has(t) ? t : null;
}

/** 수량 접두의 10의 거듭제곱 */
const PREFIX_EXPONENT: Record<string, number> = {
  '': 0, 천: 3, 만: 4, 백만: 6, 천만: 7, 억: 8, 십억: 9, 백억: 10, 조: 12,
};

/**
 * 정본 단위를 기본 단위와 10의 지수로 가른다('천원' → 원·3). 단독 단위는 지수 0.
 * 단위 충돌 안내에서 scale 예시(원 → 천원이면 0.001)를 내는 데만 쓴다 — 자동으로 바꾸지 않는다
 */
export function unitMagnitude(unit: string): { base: string; exponent: number } | null {
  if (STANDALONE_UNITS.includes(unit)) return { base: unit, exponent: 0 };
  // 긴 접두부터 — '천만원'은 '천'+'만원'이 아니라 '천만'+'원'
  const prefixes = Object.keys(PREFIX_EXPONENT).sort((a, b) => b.length - a.length);
  for (const p of prefixes) {
    if (!unit.startsWith(p)) continue;
    const base = unit.slice(p.length);
    if (BASE_UNITS.includes(base)) return { base, exponent: PREFIX_EXPONENT[p] };
  }
  return null;
}
