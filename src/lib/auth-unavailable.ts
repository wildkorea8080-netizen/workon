// src/lib/auth-unavailable.ts
// Supabase Auth의 비밀번호 확인 실패가 '틀린 비밀번호'인지 '지금 확인할 수 없음'인지 가른다 — 아무것도 import하지 않는다.
//
// 2026-11-20: 로그인·비밀번호 바꾸기는 Auth 확인이 실패하면 무엇이든 '틀린 비밀번호'로 보아 로그인 실패로 셌다. Auth가 잠깐
// 응답하지 않는 동안(연결 실패·5xx·요청 몰림 429) 로그인을 시도한 직원은 30분 5번에 계정이 잠기고, 기관이 바깥 주소 하나를 함께 쓰면
// 30번에 **기관 전체의 로그인이 30분 막혔다**(IP 잠금 — 기관 관리자도 같은 주소라 풀 수 없다). 화면은 '비밀번호가 올바르지 않습니다'였다.
// 틀린 비밀번호는 Auth가 4xx(400 invalid_credentials 등)로 답한다 — 그것만 실패로 센다.

export function isAuthUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { status?: unknown; name?: unknown };
  if (e.name === 'AuthRetryableFetchError') return true;
  const status = typeof e.status === 'number' ? e.status : Number(e.status);
  // 상태가 없으면(연결 실패) 확인하지 못한 것이다
  if (!Number.isFinite(status) || status === 0) return true;
  return status >= 500 || status === 429 || status === 408;
}

export const AUTH_UNAVAILABLE = 'AUTH_UNAVAILABLE';
export const AUTH_UNAVAILABLE_MESSAGE = '지금 로그인 정보를 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요. (비밀번호가 틀린 것은 아닙니다 — 로그인 실패로 세지 않았습니다.)';
