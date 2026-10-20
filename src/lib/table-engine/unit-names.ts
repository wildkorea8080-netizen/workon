/**
 * 알려진 단위와 표기 정리. 아무것도 import하지 않는 잎 파일이다 —
 * number.ts(칸 읽기)와 units.ts(열 단위 찾기)가 서로를 부르는 순환을 막으려고 따로 둔다.
 * 단위를 모르면 null: 모르는 단위를 아는 단위로 짐작하면 합계가 조용히 틀린다.
 */

/** 알려진 단위. 여기 없는 표기('만원' 등)는 값 칸에서 읽지 못함으로 떨어진다 */
export const KNOWN_UNITS: readonly string[] = [
  '원', '천원', '백만원', '억원', '조원', '%', '명', '건', '개', '개소', '회', '톤', 'kg', 'ha', '㎡',
];

const KNOWN = new Set(KNOWN_UNITS);

/** 공백(전각·줄바꿈 포함)을 모두 뗀다 — '천 원'과 '천원'이 같은 단위. 영문 단위는 소문자로 */
export function normalizeUnit(raw: string): string | null {
  const t = raw.replace(/\s+/g, '').toLowerCase();
  return KNOWN.has(t) ? t : null;
}
