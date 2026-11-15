import { createHash } from 'crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * 로그인 실패 잠금(2026-11-13, 0091).
 *
 * 예전에는 로그인 실패를 세지 않아 비밀번호를 끝없이 맞춰 볼 수 있었다 — 특히 관리자가 등록해 `users.password_hash`로 들어오는
 * 계정은 Supabase Auth의 횟수 제한도 거치지 않는다. 공공기관 보안 점검의 '로그인 실패 시 계정 잠금' 항목이다.
 *
 * - 한 계정(이메일)이 30분 안에 5번 틀리면 잠근다 — 잠긴 동안은 맞는 비밀번호도 받지 않고(잠금이 뜻을 가지려면), 실패를 더 세지 않는다
 *   (가장 오래된 실패가 30분을 넘기면 풀린다). 성공하면 그 계정의 실패를 지운다.
 * - 한 IP가 30분 안에 30번 틀리면 그 IP를 막는다(여러 계정을 돌아가며 맞춰 보기).
 * - 이메일은 그대로 두지 않고 SHA-256만 남긴다. IP도 해시.
 * - 실패 기록을 못 읽으면 **막지 않는다**(DB가 흔들려 모든 직원이 못 들어오면 안 된다) — 잠금은 비밀번호 위에 얹는 두 번째 층이다.
 */

export const LOCK_FAILURES = 5;
export const IP_FAILURES = 30;
export const LOCK_WINDOW_MS = 30 * 60_000;
// 화면도 읽는 값은 잎 파일에(로그인 화면이 이 서버 모듈을 불러오지 않게)
export { ACCOUNT_LOCKED, LOCKED_MESSAGE } from '@/lib/sign-in-lock-spec';

export type SignInScope = 'user' | 'super';

export function signInKey(email: unknown): string {
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
  return createHash('sha256').update(`signin:${normalized}`).digest('hex');
}

export function ipKey(ip: string | null | undefined): string | null {
  return ip ? createHash('sha256').update(`ip:${ip}`).digest('hex') : null;
}

export interface ThrottleDeps {
  /** 그때 뒤의 실패 수 — 못 읽으면 null */
  countFailures(scope: SignInScope, field: 'key_hash' | 'ip_hash', value: string, sinceIso: string): Promise<number | null>;
  recordFailure(scope: SignInScope, keyHash: string, ipHash: string | null): Promise<void>;
  clearFailures(scope: SignInScope, keyHash: string): Promise<void>;
}

/** 지금 로그인을 받아도 되는가 — 잠겼으면 false. 못 읽으면 true(열림) */
export async function signInAllowed(deps: ThrottleDeps, scope: SignInScope, email: unknown, ip: string | null, nowMs = Date.now()): Promise<boolean> {
  const since = new Date(nowMs - LOCK_WINDOW_MS).toISOString();
  const [byKey, byIp] = await Promise.all([
    deps.countFailures(scope, 'key_hash', signInKey(email), since).catch(() => null),
    ipKey(ip) ? deps.countFailures(scope, 'ip_hash', ipKey(ip)!, since).catch(() => null) : Promise.resolve(null),
  ]);
  if (byKey !== null && byKey >= LOCK_FAILURES) return false;
  if (byIp !== null && byIp >= IP_FAILURES) return false;
  return true;
}

export async function noteSignInFailure(deps: ThrottleDeps, scope: SignInScope, email: unknown, ip: string | null): Promise<void> {
  await deps.recordFailure(scope, signInKey(email), ipKey(ip)).catch(() => {});
}

export async function noteSignInSuccess(deps: ThrottleDeps, scope: SignInScope, email: unknown): Promise<void> {
  await deps.clearFailures(scope, signInKey(email)).catch(() => {});
}

export function throttleDeps(): ThrottleDeps {
  return {
    async countFailures(scope, field, value, sinceIso) {
      const { count, error } = await supabaseAdmin
        .from('sign_in_failures')
        .select('id', { count: 'exact', head: true })
        .eq('scope', scope)
        .eq(field, value)
        .gte('created_at', sinceIso);
      return error ? null : count ?? 0;
    },
    async recordFailure(scope, keyHash, ipHash) {
      await supabaseAdmin.from('sign_in_failures').insert({ scope, key_hash: keyHash, ip_hash: ipHash });
      // 하루 지난 기록은 가끔 치운다(표가 끝없이 자라지 않게)
      if (Math.random() < 0.05) {
        await supabaseAdmin.from('sign_in_failures').delete().lt('created_at', new Date(Date.now() - 24 * 60 * 60_000).toISOString());
      }
    },
    async clearFailures(scope, keyHash) {
      await supabaseAdmin.from('sign_in_failures').delete().eq('scope', scope).eq('key_hash', keyHash);
    },
  };
}

/** NextAuth의 req.headers(평범한 객체)에서 IP 하나 */
export function requestIp(headers: Record<string, unknown> | { get(name: string): string | null } | undefined | null): string | null {
  if (!headers) return null;
  const get = (name: string): string | null => {
    if (typeof (headers as { get?: unknown }).get === 'function') return (headers as { get(n: string): string | null }).get(name);
    const v = (headers as Record<string, unknown>)[name];
    return typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : null;
  };
  const raw = get('x-vercel-forwarded-for') ?? get('x-real-ip') ?? get('x-forwarded-for')?.split(',')[0] ?? null;
  const ip = raw?.trim() ?? '';
  return ip && ip.length <= 64 ? ip : null;
}
