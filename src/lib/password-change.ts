import bcrypt from 'bcryptjs';
import { supabase } from '@/lib/supabase';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { canSignIn } from '@/lib/user-withdrawal';
import { passwordPolicyError } from '@/lib/password-policy';
import { noteSignInFailure, noteSignInSuccess, signInAllowed, type ThrottleDeps } from '@/lib/sign-in-throttle';

/**
 * 직원 본인의 비밀번호 바꾸기(2026-11-16). 예전에는 직원이 비밀번호를 바꾸는 길이 없어, 관리자가 등록하며 준
 * 임시 비밀번호를 계속 써야 했다.
 *
 * 로그인에는 두 길이 있다(`nextAuthOptions.ts`) — Supabase Auth, 그게 실패하면 `users.password_hash`. 그래서 바꿀 때
 * - 지금 비밀번호를 두 길 중 하나로 확인하고(로그인 실패 잠금과 같은 셈 — 틀리면 실패로 센다, 잠겨 있으면 막는다)
 * - Supabase Auth 계정이 있으면 그 비밀번호를 바꾸고,
 * - `password_hash`가 있으면(또는 Auth 계정이 없으면) 새 비밀번호의 해시로 바꾼다 — 옛 해시를 남기면 Auth가 새 비밀번호로 바뀐 뒤에도
 *   옛 비밀번호가 두 번째 길로 통과한다.
 */

export type PasswordChangeResult =
  | { ok: true }
  | { ok: false; code: 'locked' | 'wrong' | 'same' | 'policy' | 'not_found' | 'error'; message?: string };

export interface PasswordChangeDeps {
  throttle: ThrottleDeps;
  readUser(id: string): Promise<{ email: string | null; password_hash: string | null; is_active?: boolean | null; deleted_at?: string | null } | null | 'error'>;
  /** Supabase Auth로 그 이메일·비밀번호가 맞으면 그 계정 id */
  verifyAuth(email: string, password: string): Promise<string | null>;
  compareHash(password: string, hash: string): Promise<boolean>;
  updateAuthPassword(id: string, password: string): Promise<'ok' | 'not_found' | 'error'>;
  hash(password: string): Promise<string>;
  setPasswordHash(id: string, hash: string): Promise<boolean>;
}

export async function changeOwnPassword(
  deps: PasswordChangeDeps,
  input: { userId: string; current: unknown; next: unknown; ip: string | null },
): Promise<PasswordChangeResult> {
  const { userId, ip } = input;
  if (typeof input.current !== 'string' || !input.current) return { ok: false, code: 'wrong', message: '지금 비밀번호를 입력해 주세요.' };
  const current = input.current;
  const row = await deps.readUser(userId);
  if (row === 'error') return { ok: false, code: 'error' };
  if (!row || !row.email || !canSignIn(row)) return { ok: false, code: 'not_found' };
  const email = row.email;

  if (!(await signInAllowed(deps.throttle, 'user', email, ip))) return { ok: false, code: 'locked' };

  const policy = passwordPolicyError(input.next, { email });
  if (policy) return { ok: false, code: 'policy', message: policy };
  const next = input.next as string;
  if (next === current) return { ok: false, code: 'same', message: '지금 비밀번호와 다른 비밀번호를 입력해 주세요.' };

  // 지금 비밀번호 확인 — 로그인과 같은 두 길
  const authId = await deps.verifyAuth(email, current).catch(() => null);
  const viaAuth = authId === userId;
  const viaHash = !viaAuth && Boolean(row.password_hash) && (await deps.compareHash(current, row.password_hash!).catch(() => false));
  if (!viaAuth && !viaHash) {
    await noteSignInFailure(deps.throttle, 'user', email, ip);
    return { ok: false, code: 'wrong', message: '지금 비밀번호가 맞지 않습니다.' };
  }
  await noteSignInSuccess(deps.throttle, 'user', email);

  const auth = await deps.updateAuthPassword(userId, next);
  if (auth === 'error') return { ok: false, code: 'error' };
  if (auth === 'not_found' || row.password_hash) {
    const ok = await deps.setPasswordHash(userId, await deps.hash(next));
    if (!ok) return { ok: false, code: 'error' };
  }
  return { ok: true };
}

export function passwordChangeDeps(throttle: ThrottleDeps): PasswordChangeDeps {
  return {
    throttle,
    async readUser(id) {
      const { data, error } = await supabaseAdmin
        .from('users')
        .select('email, password_hash, is_active, deleted_at')
        .eq('id', id)
        .maybeSingle();
      if (error) return 'error';
      return data ?? null;
    },
    async verifyAuth(email, password) {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error || !data?.user) return null;
      // 로그인(`nextAuthOptions.ts`)과 같은 공개 키 클라이언트(세션을 저장하지 않음)로 확인만 한다
      return data.user.id;
    },
    compareHash: (password, hash) => bcrypt.compare(password, hash),
    async updateAuthPassword(id, password) {
      const { error } = await supabaseAdmin.auth.admin.updateUserById(id, { password });
      if (!error) return 'ok';
      const status = (error as { status?: number }).status;
      return status === 404 || /not.?found/i.test(error.message ?? '') ? 'not_found' : 'error';
    },
    hash: (password) => bcrypt.hash(password, 12),
    async setPasswordHash(id, hash) {
      const { error } = await supabaseAdmin.from('users').update({ password_hash: hash }).eq('id', id);
      return !error;
    },
  };
}
