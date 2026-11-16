import crypto from 'crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { canSignIn } from '@/lib/user-withdrawal';
import { passwordPolicyError } from '@/lib/password-policy';
import { passwordChangeDeps, type PasswordChangeDeps } from '@/lib/password-change';
import { ipKey, throttleDeps, unlockSignIn } from '@/lib/sign-in-throttle';
import { isMailConfigured, sendPasswordResetLinkEmail } from '@/lib/mailer';
import { logSystem } from '@/lib/logger';
import { APP_URL } from '@/lib/config';
import { RESET_LINK_MINUTES, RESET_TOKEN_PATTERN } from '@/lib/password-reset-spec';

/**
 * 직원 비밀번호 찾기 — 메일 재설정 링크(2026-11-16, 0096).
 *
 * 예전에는 비밀번호를 잊은 직원이 관리자에게 임시 비밀번호 재발급을 부탁하는 길뿐이었다.
 *
 * - **요청**(`requestPasswordReset`): 이메일을 받으면 그 주소가 쓸 수 있는 직원 계정(활성·탈퇴 안 함·슈퍼관리자 아님)일 때만
 *   30분짜리 링크를 메일로 보낸다. **계정이 있든 없든, 계정당 상한에 걸렸든 응답은 같다** — 어떤 주소가 등록돼 있는지
 *   알아내는 통로가 되지 않게. IP마다 1시간 10번을 넘으면 429(이것은 계정과 상관없다). 메일이 설정되지 않은 배포는 503.
 * - **링크의 열쇠**는 32바이트 난수(base64url 43자)이고 원문은 메일에만 — DB에는 SHA-256만. 주소의 `#token=`(조각)에 실어
 *   서버 기록·Referer에 남지 않게 한다. 새로 요청하면 그 계정의 앞 링크는 끝난다.
 * - **재설정**(`confirmPasswordReset`): 열쇠가 살아 있고(안 씀·기한 안) 계정이 지금도 쓸 수 있을 때만. 비밀번호 규칙을 먼저 보고,
 *   열쇠를 조건부로 차지한 뒤(두 번 못 씀) 로그인 두 길(Supabase Auth·`password_hash`)을 함께 바꾼다 — 옛 해시가 남으면 옛 비밀번호가
 *   두 번째 길로 통과한다. 바꾼 때를 적어(0092) 그 전의 로그인을 모두 끝내고 임시 비밀번호 표시(0093)를 지우며 로그인 실패 잠금도 푼다.
 *   바꾸다 실패하면 열쇠를 돌려놓아 같은 링크로 다시 할 수 있다.
 * - 사용 중지된 계정(관리자·장기 미접속 잠금)은 메일을 받지 못하고 재설정도 안 된다 — 관리자의 '다시 사용'을 비밀번호 찾기로 건너뛰지 못하게.
 */

export { RESET_LINK_MINUTES } from '@/lib/password-reset-spec';
export const RESET_WINDOW_MS = 60 * 60_000;
export const RESET_PER_USER = 3;
export const RESET_PER_IP = 10;

export interface ResetUser {
  id: string;
  email: string;
  full_name?: string | null;
  department_id?: string | null;
  password_hash?: string | null;
  is_active?: boolean | null;
  deleted_at?: string | null;
  is_super_admin?: boolean | null;
}

export interface ResetDeps extends Pick<PasswordChangeDeps, 'updateAuthPassword' | 'hash' | 'setPasswordHash' | 'markPasswordChanged'> {
  mailConfigured(): boolean;
  findUserByEmail(email: string): Promise<ResetUser | null | 'error'>;
  readUser(id: string): Promise<ResetUser | null | 'error'>;
  /** 그때 뒤의 요청 수 — 못 읽으면 null(열림) */
  countRequests(field: 'user_id' | 'ip_hash', value: string, sinceIso: string): Promise<number | null>;
  insertRequest(row: { user_id: string | null; token_hash: string | null; ip_hash: string | null; expires_at: string | null }): Promise<string | null>;
  /** 그 계정의 살아 있는 링크를 끝낸다(지금 것 하나는 빼고) */
  expireOpen(userId: string, nowIso: string, exceptId?: string): Promise<void>;
  findToken(tokenHash: string): Promise<{ id: string; user_id: string | null; expires_at: string | null; used_at: string | null } | null | 'error'>;
  /** 안 쓰고 기한 안인 열쇠만 차지 — 차지했으면 true */
  claimToken(id: string, nowIso: string): Promise<boolean>;
  releaseToken(id: string): Promise<void>;
  unlock(email: string): Promise<void>;
  sendLink(to: string, fullName: string, link: string): Promise<boolean>;
  newToken(): string;
  log(message: string, details: Record<string, unknown>): Promise<void>;
}

export function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(`pwreset:${token}`).digest('hex');
}

export function newResetToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function resetLink(token: string, base = APP_URL): string {
  return `${base.replace(/\/+$/, '')}/reset-password#token=${token}`;
}

/** 쓸 수 있는 직원 계정인가 — 슈퍼관리자는 이 길을 쓰지 않는다(다른 슈퍼관리자가 계정 관리에서 바꾼다) */
function resettable(user: ResetUser | null | 'error'): user is ResetUser {
  return Boolean(user && user !== 'error' && user.email && canSignIn(user) && !user.is_super_admin);
}

export type ResetRequestResult = { ok: true } | { ok: false; code: 'mail_off' | 'ip_limited' | 'error' };

export async function requestPasswordReset(
  deps: ResetDeps,
  input: { email: unknown; ip: string | null },
  now = new Date(),
): Promise<ResetRequestResult> {
  if (!deps.mailConfigured()) return { ok: false, code: 'mail_off' };
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  const ipHash = ipKey(input.ip);
  const since = new Date(now.getTime() - RESET_WINDOW_MS).toISOString();

  if (ipHash) {
    const byIp = await deps.countRequests('ip_hash', ipHash, since).catch(() => null);
    if (byIp !== null && byIp >= RESET_PER_IP) return { ok: false, code: 'ip_limited' };
  }
  // 세기용 한 줄(계정 없음·상한) — 응답은 성공과 같다
  const countOnly = async () => {
    await deps.insertRequest({ user_id: null, token_hash: null, ip_hash: ipHash, expires_at: null }).catch(() => null);
    return { ok: true } as const;
  };
  if (!email || email.length > 254 || !email.includes('@')) return countOnly();

  const user = await deps.findUserByEmail(email).catch(() => 'error' as const);
  if (user === 'error') return { ok: false, code: 'error' };
  if (!resettable(user)) return countOnly();

  const byUser = await deps.countRequests('user_id', user.id, since).catch(() => null);
  if (byUser !== null && byUser >= RESET_PER_USER) return countOnly();

  const token = deps.newToken();
  const id = await deps.insertRequest({
    user_id: user.id,
    token_hash: tokenHash(token),
    ip_hash: ipHash,
    expires_at: new Date(now.getTime() + RESET_LINK_MINUTES * 60_000).toISOString(),
  }).catch(() => null);
  if (!id) return { ok: false, code: 'error' };
  await deps.expireOpen(user.id, now.toISOString(), id).catch(() => {});

  const sent = await deps.sendLink(user.email, user.full_name || user.email, resetLink(token)).catch(() => false);
  if (!sent) {
    // 메일을 못 보냈어도 응답은 같다(계정이 있는 주소에만 다른 답을 주면 등록 여부가 드러난다). 운영 기록에만 — 주소 없이
    await deps.log('비밀번호 찾기 메일을 보내지 못했습니다', { user_id: user.id }).catch(() => {});
  }
  return { ok: true };
}

export type ResetConfirmResult =
  | { ok: true; userId: string; departmentId: string | null; sessionsKept: boolean }
  | { ok: false; code: 'invalid' | 'policy' | 'error'; message?: string };

export async function confirmPasswordReset(
  deps: ResetDeps,
  input: { token: unknown; next: unknown },
  now = new Date(),
): Promise<ResetConfirmResult> {
  const invalid = { ok: false, code: 'invalid', message: '링크가 만료되었거나 이미 쓰였습니다. 비밀번호 찾기를 다시 요청해 주세요.' } as const;
  if (typeof input.token !== 'string' || !RESET_TOKEN_PATTERN.test(input.token)) return invalid;
  const row = await deps.findToken(tokenHash(input.token)).catch(() => 'error' as const);
  if (row === 'error') return { ok: false, code: 'error' };
  if (!row || !row.user_id || row.used_at || !row.expires_at || Date.parse(row.expires_at) <= now.getTime()) return invalid;

  const user = await deps.readUser(row.user_id).catch(() => 'error' as const);
  if (user === 'error') return { ok: false, code: 'error' };
  if (!resettable(user)) return invalid;

  const policy = passwordPolicyError(input.next, { email: user.email });
  if (policy) return { ok: false, code: 'policy', message: policy };
  const next = input.next as string;

  if (!(await deps.claimToken(row.id, now.toISOString()).catch(() => false))) return invalid;

  const fail = async (): Promise<ResetConfirmResult> => {
    await deps.releaseToken(row.id).catch(() => {});
    return { ok: false, code: 'error' };
  };
  const auth = await deps.updateAuthPassword(user.id, next).catch(() => 'error' as const);
  if (auth === 'error') return fail();
  if (auth === 'not_found' || user.password_hash) {
    const hashed = await deps.hash(next);
    if (!(await deps.setPasswordHash(user.id, hashed).catch(() => false))) return fail();
  }
  const marked = await deps.markPasswordChanged(user.id, false).catch(() => false);
  await deps.expireOpen(user.id, now.toISOString()).catch(() => {});
  await deps.unlock(user.email).catch(() => {});
  return { ok: true, userId: user.id, departmentId: user.department_id ?? null, sessionsKept: !marked };
}

const USER_COLUMNS = 'id, email, full_name, department_id, password_hash, is_active, deleted_at, is_super_admin';

export function resetDeps(): ResetDeps {
  const base = passwordChangeDeps(throttleDeps());
  return {
    updateAuthPassword: base.updateAuthPassword,
    hash: base.hash,
    setPasswordHash: base.setPasswordHash,
    markPasswordChanged: base.markPasswordChanged,
    mailConfigured: isMailConfigured,
    async findUserByEmail(email) {
      // 로그인과 같이 적힌 그대로 찾고, 없으면 소문자로 한 번 더(가입은 대개 소문자)
      for (const candidate of Array.from(new Set([email, email.toLowerCase()]))) {
        const { data, error } = await supabaseAdmin.from('users').select(USER_COLUMNS).eq('email', candidate).limit(2);
        if (error) return 'error';
        if (data && data.length === 1) return data[0] as ResetUser;
        if (data && data.length > 1) return null; // 같은 주소가 둘이면 고르지 않는다
      }
      return null;
    },
    async readUser(id) {
      const { data, error } = await supabaseAdmin.from('users').select(USER_COLUMNS).eq('id', id).maybeSingle();
      if (error) return 'error';
      return (data as ResetUser | null) ?? null;
    },
    async countRequests(field, value, sinceIso) {
      const { count, error } = await supabaseAdmin
        .from('password_reset_requests')
        .select('id', { count: 'exact', head: true })
        .eq(field, value)
        .gte('created_at', sinceIso);
      return error ? null : count ?? 0;
    },
    async insertRequest(row) {
      const { data, error } = await supabaseAdmin.from('password_reset_requests').insert(row).select('id').single();
      if (error || !data) return null;
      // 하루 지난 줄은 가끔 치운다(표가 끝없이 자라지 않게)
      if (Math.random() < 0.05) {
        await supabaseAdmin.from('password_reset_requests').delete().lt('created_at', new Date(Date.now() - 24 * 60 * 60_000).toISOString());
      }
      return (data as { id: string }).id;
    },
    async expireOpen(userId, nowIso, exceptId) {
      let q = supabaseAdmin
        .from('password_reset_requests')
        .update({ expires_at: nowIso })
        .eq('user_id', userId)
        .is('used_at', null)
        .gt('expires_at', nowIso);
      if (exceptId) q = q.neq('id', exceptId);
      await q;
    },
    async findToken(hash) {
      const { data, error } = await supabaseAdmin
        .from('password_reset_requests')
        .select('id, user_id, expires_at, used_at')
        .eq('token_hash', hash)
        .maybeSingle();
      if (error) return 'error';
      return data ?? null;
    },
    async claimToken(id, nowIso) {
      const { data, error } = await supabaseAdmin
        .from('password_reset_requests')
        .update({ used_at: nowIso })
        .eq('id', id)
        .is('used_at', null)
        .gt('expires_at', nowIso)
        .select('id');
      return !error && Array.isArray(data) && data.length === 1;
    },
    async releaseToken(id) {
      await supabaseAdmin.from('password_reset_requests').update({ used_at: null }).eq('id', id);
    },
    unlock: (email) => unlockSignIn('user', email),
    async sendLink(to, fullName, link) {
      const r = await sendPasswordResetLinkEmail({ to, fullName, resetUrl: link, minutes: RESET_LINK_MINUTES });
      return r.sent;
    },
    newToken: newResetToken,
    log: (message, details) => logSystem({ level: 'warning', category: 'auth', message, details }),
  };
}
