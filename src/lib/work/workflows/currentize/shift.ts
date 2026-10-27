// src/lib/work/workflows/currentize/shift.ts
import type { Finding } from './classify';

/**
 * 연도·날짜 밀기(S6-1). 분류가 찾아 준 `year`·`date` 조각만, 자리(offset) 그대로 fromYear → toYear로 바꾼다.
 * 글에서 연도를 스스로 다시 찾지 않는다 — 문서번호('2025-123호')·인용('「2025년 제정 조례」')·
 * 기간의 시작('2025년부터')은 분류가 연도로 내지 않으므로 여기서도 그대로 남는다.
 * `period`(전년도·금년도…)는 뜻이 이미 상대적이라 건드리지 않는다. 순수 함수.
 */

// 조각 글에서 연도 부분: 아포스트로피 두 자리('25) 또는 네 자리 숫자(2025년 · 2025. 1. 1.)
const APOSTROPHE_YEAR = /^(['’‘])(\d\d)(?!\d)/;
const FULL_YEAR = /^(\d{4})(?!\d)/;

/** 조각 글 앞머리의 연도를 읽는다(바꿀 부분의 길이와 값) */
function leadingYear(text: string): { prefix: string; digits: string; year: number } | null {
  const ap = APOSTROPHE_YEAR.exec(text);
  if (ap) return { prefix: ap[1], digits: ap[2], year: 2000 + Number(ap[2]) };
  const full = FULL_YEAR.exec(text);
  if (full) return { prefix: '', digits: full[1], year: Number(full[1]) };
  return null;
}

export function shiftYears(
  text: string,
  findings: Finding[],
  fromYear: number,
  toYear: number,
): { text: string; changed: boolean } {
  const targets = findings
    .filter((f) => f.kind === 'year' || f.kind === 'date')
    // 자리와 글이 맞지 않는 조각(다른 글에서 온 것)은 믿지 않는다
    .filter((f) => text.slice(f.start, f.end) === f.text)
    .sort((a, b) => b.start - a.start); // 뒤에서 앞으로 — 앞쪽 자리가 밀리지 않게

  let out = text;
  let changed = false;
  for (const f of targets) {
    const lead = leadingYear(f.text);
    if (!lead || lead.year !== fromYear) continue;
    const next = lead.digits.length === 2 ? String(toYear % 100).padStart(2, '0') : String(toYear);
    const from = f.start + lead.prefix.length;
    out = out.slice(0, from) + next + out.slice(from + lead.digits.length);
    changed = true;
  }
  return { text: out, changed };
}

/** 조각들 가운데 가장 많이 나온 연도. 아포스트로피 연도는 2000+yy, 동률이면 큰 연도, 없으면 null */
export function dominantYear(findings: Finding[]): number | null {
  const counts = new Map<number, number>();
  for (const f of findings) {
    if (f.kind !== 'year' && f.kind !== 'date') continue;
    const lead = leadingYear(f.text);
    if (lead) counts.set(lead.year, (counts.get(lead.year) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [year, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && year > best)) {
      best = year;
      bestCount = count;
    }
  }
  return best;
}
