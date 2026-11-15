/**
 * 로그인 실패 잠금의 화면 공용 값(2026-11-13) — 아무것도 import하지 않는다(로그인 화면이 읽는다).
 * 서버 쪽 규칙은 `sign-in-throttle.ts`.
 */
export const ACCOUNT_LOCKED = 'ACCOUNT_LOCKED';
export const LOCKED_MESSAGE = '로그인을 여러 번 실패해 30분 동안 잠겼습니다. 잠시 뒤 다시 시도하거나 관리자에게 문의하세요.';
