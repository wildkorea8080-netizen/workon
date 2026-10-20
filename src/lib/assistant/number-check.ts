// src/lib/assistant/number-check.ts
/**
 * 숫자 확인(설계 5.4) — 첨부 도구를 쓴 턴의 답변 숫자를 그 턴에 AI가 **본** 숫자와 대조한다.
 *
 * NODA 답변 검증(S4) 전에 프로그램 대조로 같은 목적을 먼저 이룬다. 근거 없는 숫자를 막지는 못하고
 * **보이게** 한다 — 답변 글은 고치지 않는다(저장 내용과 화면이 어긋나지 않게).
 * 두 값의 차이처럼 AI가 계산해 말한 숫자는 걸릴 수 있어 문구는 "틀렸다"가 아니라 "확인되지 않았다"다.
 *
 * 화면(MessageBubble)도 NUMBER_CHECK_NOTE를 읽으므로 아무것도 import하지 않는다.
 */

/** 이 도구가 한 번이라도 성공한 턴만 대조한다 — 첨부를 안 본 답의 숫자는 대조할 원본이 없다 */
export const NUMBER_CHECK_TOOLS: ReadonlySet<string> = new Set(['read_attachment', 'combine_tables']);

/** 안내에 싣는 숫자 수. 많으면 안내가 답보다 길어진다 */
const MAX_UNVERIFIED = 10;

export const NUMBER_CHECK_NOTE = (list: string[]): string =>
  `원본·계산 결과에서 확인되지 않은 숫자: ${list.join(' · ')} — 직접 확인하세요`;

interface Token {
  raw: string;
  value: number;
  decimals: number;
  start: number;
  end: number;
  /** 쉼표 없이 쓴 정수 — 연도 판정용('2,026'은 연도가 아니다) */
  plain: boolean;
  /** 숫자 부분의 정수 자릿수 */
  intDigits: number;
  /** 'a1'·'t3'처럼 영문자에 붙은 숫자 — 첨부·표 id */
  id: boolean;
}

// 부호: △▲(증감 표기, 한 칸 띄움 허용) 또는 숫자에 바로 붙은 '-'. 수는 세 자리 쉼표 묶음이 끝까지 맞을 때만 한 수로 —
// '1,2345'를 '1,234'+'5'로 자르지 않게 (?!\d)로 묶음 끝을 확인하고, 아니면 쉼표에서 나눈다.
const NUMBER = /([△▲] ?|[-−](?=\d))?(\d{1,3}(?:,\d{3})+(?!\d)|\d+)(\.\d+)?/g;

function tokens(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(NUMBER)) {
    let start = m.index ?? 0;
    let sign = m[1] ?? '';
    // '2024-2025'·'1,000-2,000'·'S3-1'의 '-'는 범위·이름 구분이지 음수가 아니다
    if (sign && /[-−]/.test(sign) && start > 0 && /[\dA-Za-z.]/.test(text[start - 1])) {
      start += sign.length;
      sign = '';
    }
    const digits = m[2];
    const frac = m[3] ?? '';
    let end = (m.index ?? 0) + m[0].length;
    let raw = text.slice(start, end);
    let negative = sign !== '';
    // 회계식 음수 '(1,234)' — 괄호가 숫자만 감쌀 때. '총무과(1,234천원)'은 덧붙인 설명이라 양수
    if (text[start - 1] === '(' && text[end] === ')') {
      negative = true;
      raw = `(${raw})`;
      start -= 1;
      end += 1;
    }
    const magnitude = Number(`${digits.replace(/,/g, '')}${frac}`);
    out.push({
      raw,
      value: negative ? -magnitude : magnitude,
      decimals: frac ? frac.length - 1 : 0,
      start,
      end,
      plain: !digits.includes(','),
      intDigits: digits.replace(/,/g, '').length,
      id: start > 0 && /[A-Za-z]/.test(text[start - 1]),
    });
  }
  return out;
}

/** 글 안의 모든 숫자 — 도구가 보여 준 값 모으기용. 작은 수·연도도 모은다(보인 것은 보인 것이다) */
export function numbersIn(text: string): number[] {
  if (!text) return [];
  return tokens(text).map((t) => t.value);
}

// 대조하지 않는 꼴. 숫자지만 값이 아니라 날짜·시각·연락처다
const SKIP_PATTERNS: RegExp[] = [
  /(?<!\d)\d{4} ?[.\-/] ?\d{1,2} ?[.\-/] ?\d{1,2}(?!\d)\.?/g, // 2026.10.21 · 2026-10-21 · 2026. 10. 21.
  /(?<!\d)\d{2}\. ?\d{1,2}\. ?\d{1,2}\./g, // 26. 3. 5. (끝 마침표까지 — '36.6. 3곳' 같은 글을 날짜로 보지 않게)
  /(?<!\d)(?:19\d{2}|20\d{2}|2100) ?[.\-/] ?(?:1[0-2]|0?[1-9])(?!\d)/g, // 2026.10 · 2026. 10.
  /(?<!\d)\d{4} ?년/g,
  /(?<!\d)\d{1,2} ?월(?: ?\d{1,2} ?일)?/g,
  /(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?!\d)/g, // 10:30
  /(?<!\d)0\d{1,2}-\d{3,4}-\d{4}(?!\d)/g, // 02-1234-5678
  // 줄머리 소제목 번호 '## 1.1 개요'·'2.3.1 경과'·'- 1.2. 세부' — 번호 뒤에 공백이 올 때만('1.2억 원'은 값).
  // 공백 뒤가 단위 낱말이면 값('- 3.5 %p 상승'). 단위 글자로 시작하는 낱말(개요·건강·원인·명칭)은 제목이라 낱말이 끝나야 단위로 본다
  /^\s*(?:#{1,6}\s*|[-*]\s*)?\d+(?:\.\d+)+\.?(?=\s)(?!\s*(?:%p?|(?:천원|백만원|원|억|명|건|개|배|톤)(?![가-힣])))/gm,
  // 두 자리 연도 날짜 '26.10.21'(달 1~12, 날 1~31). 앞뒤에 숫자·점이 이어지면 날짜가 아니다
  /(?<![\d.])\d{2}\.(?:0?[1-9]|1[0-2])\.(?:0?[1-9]|[12]\d|3[01])(?![\d.])/g,
];

function skippedSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const re of SKIP_PATTERNS) {
    for (const m of text.matchAll(re)) spans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  return spans;
}

/**
 * 대조 대상 숫자. 뺄 것(설계 5.4): 4자리 미만 정수(목록 번호·개수 대부분 — 소수는 대조), 1900~2100 연도,
 * 날짜·시각 꼴(두 자리 연도 '26.10.21' 포함), 줄머리 소제목 번호('## 1.1'), 'a1'·'t3' 같은 id. 오탐이 잦으면 안내를 아무도 읽지 않는다.
 */
export function answerNumbers(text: string): { raw: string; value: number; decimals: number }[] {
  if (!text) return [];
  const spans = skippedSpans(text);
  return tokens(text)
    .filter((t) => {
      if (t.id) return false;
      if (spans.some(([s, e]) => t.start < e && t.end > s)) return false;
      if (t.decimals === 0 && t.intDigits < 4) return false;
      const abs = Math.abs(t.value);
      if (t.decimals === 0 && t.plain && abs >= 1900 && abs <= 2100) return false;
      return true;
    })
    .map(({ raw, value, decimals }) => ({ raw, value, decimals }));
}

/** 정렬된 배열에서 lo 이상인 첫 자리 */
function lowerBound(sorted: number[], lo: number): number {
  let a = 0;
  let b = sorted.length;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (sorted[mid] < lo) a = mid + 1;
    else b = mid;
  }
  return a;
}

/**
 * 답변 숫자 중 보여 준 값에서 못 찾은 것(raw, 중복 없이 나온 순서, 최대 10개).
 *
 * 일치: |v − s| ≤ 1e-9·max(1,|v|), 또는 소수 d자리 답이 s를 d자리로 반올림한 값(반 단위 안 — 경계는 양쪽 다 받는다).
 * **크기로 비교한다.** 한국어 답은 '△5,678'을 '5,678천원 감소'로 풀어 쓰고, 괄호는 음수가 아니라 덧붙인 설명일 때가 많다.
 * 부호까지 보면 이런 답이 전부 '확인되지 않음'으로 걸린다.
 */
export function checkNumbers(answer: string, shown: number[]): string[] {
  const candidates = answerNumbers(answer);
  if (candidates.length === 0) return [];
  // 도구 결과가 크면(표 200행 × 200열) 값이 수만 개다 — 정렬해 두고 범위만 찾는다
  const sorted = shown.filter(Number.isFinite).map(Math.abs).sort((x, y) => x - y);
  const out: string[] = [];
  for (const c of candidates) {
    if (out.includes(c.raw)) continue;
    const v = Math.abs(c.value);
    // 반올림 창(반 단위)이 정확 일치 허용폭을 늘 덮는다 — 둘을 더해 부동소수 끝자리 오차까지 받는다
    const tol = 0.5 * 10 ** -c.decimals + 1e-9 * Math.max(1, v);
    const i = lowerBound(sorted, v - tol);
    if (i < sorted.length && sorted[i] <= v + tol) continue;
    out.push(c.raw);
    if (out.length >= MAX_UNVERIFIED) break;
  }
  return out;
}
