/**
 * 슈퍼관리자 JWT 서명 비밀값(2026-11-13).
 *
 * 예전에는 `SUPER_JWT_SECRET`이 비면 소스에 적힌 고정 값('dev-fallback-…')으로 서명·검증했다. 운영에서 값이 빠지면
 * 누구나 그 공개된 값으로 슈퍼관리자 토큰을 만들 수 있다. 이제 **운영(NODE_ENV=production)에서는 비면 null** —
 * 서명은 던지고 검증은 거절한다(닫힘). 개발·시험에서만 고정 값을 쓴다.
 * 미들웨어(Edge)도 쓰므로 아무것도 import하지 않는다.
 */
export const SUPER_JWT_DEV_FALLBACK = 'dev-fallback-super-secret-change-in-prod';

export function superJwtSecret(env: { SUPER_JWT_SECRET?: string; NODE_ENV?: string } = process.env): string | null {
  const value = env.SUPER_JWT_SECRET;
  if (typeof value === 'string' && value.length > 0) return value;
  return env.NODE_ENV === 'production' ? null : SUPER_JWT_DEV_FALLBACK;
}

/** 길이와 상관없이 같은 시간에 두 글을 비교한다(서명·설정 키) */
export function constantTimeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
