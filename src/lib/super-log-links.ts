/**
 * 슈퍼관리자 로그 화면 주소와 심각한 운영 기록 요약(2026-11-17) — 잎 파일(화면·서버 공용, 아무것도 import하지 않음).
 *
 * 사용 기록·감사 기록·계약 맞추기 실패를 `system_logs`에 critical로 남기게 했지만(2026-11-17), 대시보드 알림 띠는 토큰 초과·계약 만료만
 * 보였고 '최근 시스템 로그'는 다섯 줄이라 금방 밀렸다. 대시보드가 최근 24시간 critical 기록을 문구별로 세어 띠에 올리고,
 * 그 링크(`/super/logs?tab=system&level=critical`)가 로그 화면을 그 거르기로 연다 — 예전에는 로그 화면이 주소의 `tab`을 읽지 않아
 * 대시보드의 '전체 보기'도 접속 로그 탭으로 열렸다. 카테고리 거르기에는 쓰고 있던 `payment`가 없었다.
 */

export type LogTab = 'access' | 'system' | 'impersonation' | 'admin';
export const LOG_TABS: readonly LogTab[] = ['access', 'system', 'impersonation', 'admin'];
export const SYSTEM_LOG_LEVELS = ['info', 'warning', 'error', 'critical'] as const;
export const SYSTEM_LOG_CATEGORIES = ['auth', 'api', 'database', 'payment', 'security', 'admin'] as const;
export const SYSTEM_LOG_PERIODS = ['today', 'week', 'month'] as const;

export interface LogLinkState { tab: LogTab; level: string; category: string; period: string }

/** 로그 화면 주소의 검색 글을 읽는다 — 모르는 값은 기본값 */
export function parseLogLink(search: string): LogLinkState {
  const sp = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const pick = <T extends string>(v: string | null, allowed: readonly T[], fallback: string) => (v && (allowed as readonly string[]).includes(v) ? v : fallback);
  return {
    tab: pick(sp.get('tab'), LOG_TABS, 'access') as LogTab,
    level: pick(sp.get('level'), SYSTEM_LOG_LEVELS, 'all'),
    category: pick(sp.get('category'), SYSTEM_LOG_CATEGORIES, 'all'),
    period: pick(sp.get('period'), SYSTEM_LOG_PERIODS, 'month'),
  };
}

export const CRITICAL_LOGS_LINK = '/super/logs?tab=system&level=critical&period=week';
export const CRITICAL_WINDOW_MS = 24 * 60 * 60_000;

/** critical 기록을 문구별로 세어 많은 것부터 셋 */
export function criticalSummary(rows: Array<{ message: string | null }>, top = 3): Array<{ message: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const m = (r.message ?? '').trim() || '(문구 없음)';
    counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  return Array.from(counts, ([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count || a.message.localeCompare(b.message))
    .slice(0, top);
}
