import { createHash } from 'crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logSystem } from '@/lib/logger';
import { maskIp } from '@/lib/sign-in-lock-spec';

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
export { ACCOUNT_LOCKED, IP_LOCKED, IP_LOCKED_MESSAGE, LOCKED_MESSAGE } from '@/lib/sign-in-lock-spec';

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

/**
 * 무엇이 잠겼는가 — 'ip'(그 IP 30번)·'account'(그 계정 5번)·null(받음). 못 읽으면 null(열림).
 * 둘 다면 'ip' — 계정 잠금을 풀어 줘도 IP 잠금이 남아 못 들어오므로, 안내는 풀 수 있는 쪽(서비스 운영자)을 가리켜야 한다(2026-11-17)
 */
export type SignInLock = 'ip' | 'account';

export async function signInLock(deps: ThrottleDeps, scope: SignInScope, email: unknown, ip: string | null, nowMs = Date.now()): Promise<SignInLock | null> {
  const since = new Date(nowMs - LOCK_WINDOW_MS).toISOString();
  const [byKey, byIp] = await Promise.all([
    deps.countFailures(scope, 'key_hash', signInKey(email), since).catch(() => null),
    ipKey(ip) ? deps.countFailures(scope, 'ip_hash', ipKey(ip)!, since).catch(() => null) : Promise.resolve(null),
  ]);
  if (byIp !== null && byIp >= IP_FAILURES) return 'ip';
  if (byKey !== null && byKey >= LOCK_FAILURES) return 'account';
  return null;
}

/** 지금 로그인을 받아도 되는가 — 잠겼으면 false. 못 읽으면 true(열림) */
export async function signInAllowed(deps: ThrottleDeps, scope: SignInScope, email: unknown, ip: string | null, nowMs = Date.now()): Promise<boolean> {
  return (await signInLock(deps, scope, email, ip, nowMs)) === null;
}

/** 실패 기록을 남기지 못했을 때 — 로그인은 막지 않고 운영 기록에(2026-11-17). 못 남기면 잠금이 걸리지 않는다 */
export const FAILURE_NOT_RECORDED = '로그인 실패를 세지 못했습니다(잠금이 걸리지 않을 수 있음)';
export const FAILURES_NOT_CLEARED = '로그인 성공 뒤 실패 기록을 지우지 못했습니다';

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code ? code.slice(0, 40) : 'error';
}

/** IP 잠금이 막 걸렸을 때(2026-11-17) — 운영자가 알게. 가린 IP·범위만 */
export const IP_LOCK_STARTED = '한 인터넷 주소(IP)에서 로그인 실패가 많아 그 주소의 로그인을 30분 막았습니다';

export async function noteSignInFailure(deps: ThrottleDeps, scope: SignInScope, email: unknown, ip: string | null, nowMs = Date.now()): Promise<void> {
  const recorded = await deps.recordFailure(scope, signInKey(email), ipKey(ip)).then(() => true, (error) =>
    logSystem({ level: 'error', category: 'security', message: FAILURE_NOT_RECORDED, details: { scope, code: errorCode(error) } }).then(() => false));
  // 이 실패로 IP가 막 잠겼으면 한 번 남긴다 — 잠긴 동안은 실패를 더 세지 않으므로(비밀번호를 보기 전에 막음) 꼭 30번째에서 한 번이다
  const hash = ipKey(ip);
  if (!recorded || !hash || !ip) return;
  const count = await deps.countFailures(scope, 'ip_hash', hash, new Date(nowMs - LOCK_WINDOW_MS).toISOString()).catch(() => null);
  if (count === IP_FAILURES) {
    await logSystem({ level: 'warning', category: 'security', message: IP_LOCK_STARTED, details: { scope, ip: maskIp(ip) } }).catch(() => {});
  }
}

/** 지금 잠긴 IP 수(2026-11-17) — 창 안 실패의 IP 해시 목록에서 30번 넘은 해시 수. 대시보드가 쓴다 */
export function lockedIpCount(ipHashes: Array<string | null>): number {
  const n = new Map<string, number>();
  for (const h of ipHashes) if (h) n.set(h, (n.get(h) ?? 0) + 1);
  return Array.from(n.values()).filter((c) => c >= IP_FAILURES).length;
}

export async function noteSignInSuccess(deps: ThrottleDeps, scope: SignInScope, email: unknown): Promise<void> {
  await deps.clearFailures(scope, signInKey(email)).catch((error) =>
    logSystem({ level: 'warning', category: 'security', message: FAILURES_NOT_CLEARED, details: { scope, code: errorCode(error) } }));
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
      // Supabase는 실패를 던지지 않고 돌려준다 — 던져서 noteSignInFailure가 운영 기록에 남기게(2026-11-17)
      const { error } = await supabaseAdmin.from('sign_in_failures').insert({ scope, key_hash: keyHash, ip_hash: ipHash });
      if (error) throw error;
      // 하루 지난 기록은 가끔 치운다(표가 끝없이 자라지 않게)
      if (Math.random() < 0.05) {
        await supabaseAdmin.from('sign_in_failures').delete().lt('created_at', new Date(Date.now() - 24 * 60 * 60_000).toISOString());
      }
    },
    async clearFailures(scope, keyHash) {
      const { error } = await supabaseAdmin.from('sign_in_failures').delete().eq('scope', scope).eq('key_hash', keyHash);
      if (error) throw error;
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

/**
 * 잠금 풀리는 때(2026-11-16) — 30분 창 안의 실패 시각(아무 순서)을 받아, 잠겼으면 풀리는 때(ISO), 아니면 null.
 * 잠긴 동안은 실패를 더 세지 않으므로, 창 안 실패가 5번 아래로 떨어지는 순간 = (n−5)번째로 오래된 실패 + 30분.
 */
export function lockedUntil(failureTimes: string[], nowMs = Date.now(), threshold = LOCK_FAILURES): string | null {
  const since = nowMs - LOCK_WINDOW_MS;
  const times = failureTimes.map((t) => Date.parse(t)).filter((t) => Number.isFinite(t) && t >= since).sort((a, b) => a - b);
  if (times.length < threshold) return null;
  return new Date(times[times.length - threshold] + LOCK_WINDOW_MS).toISOString();
}

export interface LockReadDeps {
  /** 그 해시들의 그때 뒤 실패 — 못 읽으면 null */
  listFailures(scope: SignInScope, keyHashes: string[], sinceIso: string): Promise<{ key_hash: string; created_at: string }[] | null>;
}

/** 관리 화면용 — 이메일마다 잠겨 있으면 풀리는 때. 못 읽은 것은 비움(모름 = 잠김 표시 없음) */
export async function accountLocks(deps: LockReadDeps, scope: SignInScope, emails: unknown[], nowMs = Date.now()): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const byHash = new Map<string, string[]>();
  for (const e of emails) {
    if (typeof e !== 'string' || !e.trim()) continue;
    const h = signInKey(e);
    byHash.set(h, [...(byHash.get(h) ?? []), e]);
  }
  const hashes = Array.from(byHash.keys());
  const since = new Date(nowMs - LOCK_WINDOW_MS).toISOString();
  const times = new Map<string, string[]>();
  for (let i = 0; i < hashes.length; i += LOCK_READ_CHUNK) {
    const rows = await deps.listFailures(scope, hashes.slice(i, i + LOCK_READ_CHUNK), since).catch(() => null);
    for (const r of rows ?? []) times.set(r.key_hash, [...(times.get(r.key_hash) ?? []), r.created_at]);
  }
  for (const [h, ts] of Array.from(times)) {
    const until = lockedUntil(ts, nowMs);
    if (until) for (const e of byHash.get(h) ?? []) out.set(e, until);
  }
  return out;
}

/** 한 번에 맞대는 해시 수 — 주소 길이(64자 × 100)와 응답 행 수(잠기면 더 세지 않아 해시마다 5줄 안팎)를 함께 본다 */
export const LOCK_READ_CHUNK = 100;

export function lockReadDeps(): LockReadDeps {
  return {
    async listFailures(scope, keyHashes, sinceIso) {
      const { data, error } = await supabaseAdmin
        .from('sign_in_failures')
        .select('key_hash, created_at')
        .eq('scope', scope)
        .in('key_hash', keyHashes)
        .gte('created_at', sinceIso)
        .limit(1000);
      return error ? null : (data ?? []);
    },
  };
}

/**
 * IP 잠금(2026-11-17) — 공공기관은 기관 전체가 바깥 IP 하나를 함께 쓰는 일이 많아, 여러 직원의 실수가 모이면(30분 30번)
 * 기관 전체가 30분 동안 못 들어온다. 슈퍼관리자가 IP를 넣어 잠김을 보고 푼다. IP는 해시로만 남아 있어 목록은 못 보인다.
 */
export interface IpLockStatus { failures: number; lockedUntil: string | null }

export interface IpLockDeps {
  /** 그 IP 해시의 창 안 실패 시각(두 범위) — 못 읽으면 던짐 */
  ipFailures(ipHash: string, sinceIso: string): Promise<string[]>;
  /** 그 IP 해시의 실패 기록을 지운다(두 범위) — 지운 수, 못 지우면 던짐 */
  clearIp(ipHash: string): Promise<number>;
}

export async function ipLockStatus(deps: IpLockDeps, ip: string, nowMs = Date.now()): Promise<IpLockStatus> {
  const hash = ipKey(ip)!;
  const times = await deps.ipFailures(hash, new Date(nowMs - LOCK_WINDOW_MS).toISOString());
  return { failures: times.length, lockedUntil: lockedUntil(times, nowMs, IP_FAILURES) };
}

export async function unlockIp(deps: IpLockDeps, ip: string): Promise<number> {
  return deps.clearIp(ipKey(ip)!);
}

export function ipLockDeps(): IpLockDeps {
  return {
    async ipFailures(ipHash, sinceIso) {
      const { data, error } = await supabaseAdmin.from('sign_in_failures').select('created_at').eq('ip_hash', ipHash).gte('created_at', sinceIso).limit(1000);
      if (error) throw error;
      return ((data ?? []) as { created_at: string }[]).map((r) => r.created_at);
    },
    async clearIp(ipHash) {
      const { data, error } = await supabaseAdmin.from('sign_in_failures').delete().eq('ip_hash', ipHash).select('id');
      if (error) throw error;
      return data?.length ?? 0;
    },
  };
}

/**
 * 관리자가 계정 잠금을 푼다 — 그 계정(이메일)의 실패 기록을 지운다. IP 잠금(한 IP 30번)은 그대로다
 * (그 IP로 여러 계정을 맞춰 본 것이라 한 계정을 풀어 준다고 풀 일이 아니다 — 30분 기다림).
 * 지우지 못하면 던진다(관리자 화면이 실패를 알아야 한다).
 */
export async function unlockSignIn(scope: SignInScope, email: unknown): Promise<void> {
  const { error } = await supabaseAdmin.from('sign_in_failures').delete().eq('scope', scope).eq('key_hash', signInKey(email));
  if (error) throw new Error(error.message);
}
