/** 직원 공지의 대상 규칙(2026-11-18) — `/api/notices`가 DB 조건과 함께 한 번 더 거른다. 잎 파일 */

export interface NoticeRow {
  id: string;
  title: string;
  content: string;
  importance: string | null;
  published_at: string | null;
  expires_at: string | null;
  target_type: string | null;
  target_org_ids: string[] | null;
}

/** 이 기관 직원에게 보일 공지인가 — 전체 공지이거나 대상 기관에 내 기관이 있으면 */
export function noticeVisibleTo(n: Pick<NoticeRow, 'target_type' | 'target_org_ids'>, orgId: string | null): boolean {
  if (n.target_type === 'all') return true;
  return !!orgId && Array.isArray(n.target_org_ids) && n.target_org_ids.includes(orgId);
}
