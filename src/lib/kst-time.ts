// src/lib/kst-time.ts
// 한국 시간(KST, UTC+9) 날짜 셈 한 곳(2026-11-06) — 아무것도 import하지 않는다(화면도 쓴다).
//
// 서버(Vercel)는 UTC로 돈다. `toISOString().slice(0, 10)`·`getHours()`·`new Date(y, m, 1)`은 UTC 날짜·시각이라
// 한국 00:00~09:00에 일어난 일이 **전날**로 묶이고, '이번 달'이 1일 09:00에 시작하며, 시간별 표가 9시간 밀린다.
// 기본 조회 기간의 '오늘'도 오전 9시 전에는 어제가 되어 오늘 기록이 빠졌다. 여기 함수만 쓴다.

export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const toMs = (at: Date | string | number) => (at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at));

/** 그 순간의 한국 날짜 'YYYY-MM-DD' */
export function kstDay(at: Date | string | number = Date.now()): string {
  return new Date(toMs(at) + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 그 순간의 한국 시(0~23) */
export function kstHour(at: Date | string | number): number {
  return new Date(toMs(at) + KST_OFFSET_MS).getUTCHours();
}

/** 한국 날짜 'YYYY-MM-DD'가 시작하는 순간(그날 한국 00:00) */
export function kstDayStart(day: string): Date {
  return new Date(Date.parse(`${day}T00:00:00Z`) - KST_OFFSET_MS);
}

/** 한국 날짜에 n일을 더한 날짜 */
export function addKstDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** 지금의 한국 달에서 offset달 옮긴 달의 1일 한국 00:00(offset 0 = 이번 달, -1 = 지난달) */
export function kstMonthStart(now: Date | number = Date.now(), offset = 0): Date {
  const local = new Date(toMs(now) + KST_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + offset, 1) - KST_OFFSET_MS);
}

/** from~to(둘 다 한국 날짜, 끝 포함)의 날짜 목록 — 빈 날도 채운 표를 그릴 때. 거꾸로면 빈 목록, 400일까지 */
export function kstDayList(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = addKstDays(d, 1)) out.push(d);
  return out;
}
