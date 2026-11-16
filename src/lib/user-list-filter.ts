/**
 * 기관 관리자 사용자 목록 거르기(2026-11-16) — 아무것도 import하지 않는다(화면이 읽는다).
 * 로그인 기록(0094 `last_sign_in_at`)은 2026-11-16부터 남으므로 '기록 없음'은 '한 번도 안 들어옴'이 아니라 '그 뒤로 안 들어옴'이다.
 */

export type UserListFilter = 'all' | 'inactive' | 'no_sign_in' | 'dormant';

export const USER_LIST_FILTERS: { key: UserListFilter; label: string }[] = [
  { key: 'all', label: '전체' },
  { key: 'inactive', label: '사용 중지' },
  { key: 'dormant', label: '90일 넘게 로그인 안 함' },
  { key: 'no_sign_in', label: '로그인 기록 없음(2026-11-16부터 기록)' },
];

export const DORMANT_DAYS = 90;

export function matchesUserFilter(
  user: { is_active?: boolean | null; last_sign_in_at?: string | null },
  filter: UserListFilter,
  nowMs = Date.now(),
): boolean {
  switch (filter) {
    case 'inactive':
      return user.is_active === false;
    case 'no_sign_in':
      return !user.last_sign_in_at;
    case 'dormant': {
      if (!user.last_sign_in_at) return false;
      const t = Date.parse(user.last_sign_in_at);
      return Number.isFinite(t) && t < nowMs - DORMANT_DAYS * 86_400_000;
    }
    default:
      return true;
  }
}
