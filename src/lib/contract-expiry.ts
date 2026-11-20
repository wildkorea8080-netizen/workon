/**
 * 계약 만료 표시(2026-11-19).
 *
 * 계약을 '만료'로 바꾸는 일은 어디에도 없다 — 끝날 날이 지나도 `status`는 'active'로 남는다. 예전 '만료 예정' 탭과
 * 대시보드 '계약 만료 임박'은 앞으로 30일 안에 끝나는 계약만 세어, **이미 기한이 지난 계약은 어떤 알림에도 나오지 않았고**
 * 계약 목록에는 '활성'으로 보였다. 상태 값은 바꾸지 않고(갱신·해지는 사람이 정한다) 화면에 '기한 지남'으로 보인다.
 *
 * 아무것도 import하지 않는다(화면·서버 공용).
 */
const DAY_MS = 86_400_000;

/** 남은 날(올림) — 끝날 날이 없으면 null(무기한), 지났으면 0 이하 */
export function contractDaysLeft(expiresAt: string | null | undefined, nowMs: number): number | null {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) ? Math.ceil((t - nowMs) / DAY_MS) : null;
}

/** 아직 'active'인데 끝날 날이 지났나 */
export function isContractOverdue(status: unknown, expiresAt: string | null | undefined, nowMs: number): boolean {
  if (status !== 'active' || !expiresAt) return false;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) && t <= nowMs;
}

export function contractStatusLabel(status: unknown, expiresAt: string | null | undefined, nowMs: number): string {
  if (isContractOverdue(status, expiresAt, nowMs)) return '기한 지남';
  return status === 'active' ? '활성' : status === 'expired' ? '만료' : '해지';
}

/** '만료 예정' 탭 한 줄의 남은 날 글 */
export function expiryText(daysLeft: number | null, overdue: boolean): string {
  if (daysLeft === null) return '무기한';
  if (overdue) return daysLeft === 0 ? '오늘 기한 지남' : `기한 ${-daysLeft}일 지남`;
  return `D-${daysLeft}일 남음`;
}
