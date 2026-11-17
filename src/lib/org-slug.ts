/**
 * 기관 로그인 경로(slug) — 잎 파일(화면·서버 공용, 아무것도 import하지 않음). 2026-11-17.
 *
 * 기관 전용 로그인 화면은 `/signin/{slug}`(0020 `organizations.slug`, 유일). 예전엔
 *  - 슈퍼관리자 '기관 등록'이 입력받은 Slug를 기관에 저장하지 않고 기본 부서 slug(`{slug}-main`)에만 써서, 새 기관은 로그인 경로가 없었다
 *    (운영 두 기관은 0020이 만든 `org-…` 자동 값뿐).
 *  - 슈퍼관리자 기관 상세의 '접속 URL'은 `/org/{slug}`를 복사했다 — 그런 주소는 없다(404).
 * 규칙은 기관 관리자 '기관 정보'와 같다.
 */

export const ORG_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export const ORG_SLUG_RULE = '로그인 경로는 영문 소문자·숫자·하이픈으로 3~40자여야 하며, 하이픈으로 시작하거나 끝날 수 없습니다.';

export function normalizeOrgSlug(v: unknown): { ok: true; slug: string } | { ok: false; message: string } {
  const slug = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!ORG_SLUG_PATTERN.test(slug)) return { ok: false, message: ORG_SLUG_RULE };
  return { ok: true, slug };
}

/** 기관 전용 로그인 화면의 경로 — slug가 없으면 null */
export function orgSignInPath(slug: string | null | undefined): string | null {
  return slug ? `/signin/${slug}` : null;
}
