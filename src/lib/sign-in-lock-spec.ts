/**
 * 로그인 실패 잠금의 화면 공용 값(2026-11-13) — 아무것도 import하지 않는다(로그인 화면이 읽는다).
 * 서버 쪽 규칙은 `sign-in-throttle.ts`.
 */
export const ACCOUNT_LOCKED = 'ACCOUNT_LOCKED';
export const LOCKED_MESSAGE = '로그인을 여러 번 실패해 30분 동안 잠겼습니다. 잠시 뒤 다시 시도하거나 관리자에게 문의하세요.';

/** 관리 화면의 '… 풀림' 글 — 한국 시간 시:분(오늘이 아니면 월/일도) */
export function lockUntilLabel(iso: string, nowMs = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '잠김';
  const kst = (ms: number) => new Date(ms + 9 * 3_600_000);
  const d = kst(t);
  const hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const sameDay = kst(nowMs).toISOString().slice(0, 10) === d.toISOString().slice(0, 10);
  return sameDay ? `${hm} 풀림` : `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hm} 풀림`;
}
