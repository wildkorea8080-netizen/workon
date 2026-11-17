/**
 * Supabase Auth 오류를 직원에게 보일 한국어로(2026-11-17) — 아무것도 import하지 않는다.
 *
 * 가입 라우트가 Auth의 영문 원문("Email rate limit exceeded", "Database error saving new user" 등)을 그대로 화면에 보냈다.
 * 원문은 서버 기록에만 남기고(코드·상태만), 화면에는 할 수 있는 일을 알리는 문장만 보낸다.
 */
export const AUTH_GENERIC_MESSAGE = '회원가입 중 오류가 발생했습니다. 잠시 뒤 다시 시도해 주세요.';

export function authErrorMessage(err: unknown): string {
  const raw = typeof err === 'string' ? err : (err as { message?: unknown } | null)?.message;
  const m = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (!m) return AUTH_GENERIC_MESSAGE;
  if (m.includes('already registered') || m.includes('already been registered') || m.includes('already exists')) {
    return '이미 가입된 이메일입니다. 로그인 페이지를 이용하세요.';
  }
  if (m.includes('rate limit') || m.includes('too many') || m.includes('security purposes')) {
    return '요청이 많아 잠시 막혔습니다. 몇 분 뒤 다시 시도해 주세요.';
  }
  if (m.includes('password')) return '비밀번호가 규칙에 맞지 않습니다. 더 길고 복잡한 비밀번호로 다시 시도해 주세요.';
  if (m.includes('email') && (m.includes('invalid') || m.includes('valid email'))) return '이메일 주소 형식이 올바르지 않습니다.';
  return AUTH_GENERIC_MESSAGE;
}
