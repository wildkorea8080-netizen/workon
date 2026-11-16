import crypto from 'crypto';
import { passwordChangeDeps, type PasswordChangeDeps } from '@/lib/password-change';
import { throttleDeps, unlockSignIn } from '@/lib/sign-in-throttle';

/**
 * 관리자의 임시 비밀번호 재발급(2026-11-16). 예전에는 비밀번호를 잊은 직원이 다시 들어올 길이 없었다(비밀번호 찾기도, 관리자 재설정도 없음).
 * 로그인의 두 길(Supabase Auth·`password_hash`) 모두 새 임시 비밀번호만 통하게 하고, 바꾼 때를 적어(0092) 그 전의 로그인을 모두 끝내며,
 * 로그인 실패 잠금도 푼다. 임시 비밀번호는 저장하지 않는다(해시만) — 응답과 안내 메일에 한 번만 나간다.
 */

const TEMP_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; // 0/O·1/l/I 뺌 — 말로 전하는 일이 있다
const TEMP_LENGTH = 12;

/** 암호학적 난수로 12자. 대문자·소문자·숫자가 하나씩은 들어가게 한다(본인이 바꿀 때까지 쓰는 값이라도 너무 약하지 않게) */
export function generateTempPassword(random: (n: number) => Buffer = crypto.randomBytes): string {
  for (;;) {
    const bytes = random(TEMP_LENGTH * 2);
    // 나머지 편향을 줄이려 큰 값은 버린다(55 × 4 = 220)
    const chars: string[] = [];
    for (const b of Array.from(bytes)) {
      if (b >= 220) continue;
      chars.push(TEMP_CHARS[b % TEMP_CHARS.length]);
      if (chars.length === TEMP_LENGTH) break;
    }
    const pw = chars.join('');
    if (pw.length === TEMP_LENGTH && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw)) return pw;
  }
}

export type PasswordResetDeps = Pick<PasswordChangeDeps, 'updateAuthPassword' | 'hash' | 'setPasswordHash' | 'markPasswordChanged'> & {
  unlock(email: string): Promise<void>;
  generate(): string;
};

export type PasswordResetResult = { ok: true; tempPassword: string; sessionsKept: boolean } | { ok: false };

export async function resetUserPassword(deps: PasswordResetDeps, target: { id: string; email: string }): Promise<PasswordResetResult> {
  const temp = deps.generate();
  const auth = await deps.updateAuthPassword(target.id, temp);
  if (auth === 'error') return { ok: false };
  // Auth 계정이 있어도 해시를 함께 바꾼다 — 옛 해시가 남으면 옛 비밀번호가 두 번째 길로 통과한다
  if (!(await deps.setPasswordHash(target.id, await deps.hash(temp)))) return { ok: false };
  // 임시 비밀번호 — 본인이 바꿀 때까지 '비밀번호 바꾸기'만 열린다(0093)
  const marked = await deps.markPasswordChanged(target.id, true).catch(() => false);
  await deps.unlock(target.email).catch(() => {});
  return { ok: true, tempPassword: temp, sessionsKept: !marked };
}

export function passwordResetDeps(): PasswordResetDeps {
  const base = passwordChangeDeps(throttleDeps());
  return {
    updateAuthPassword: base.updateAuthPassword,
    hash: base.hash,
    setPasswordHash: base.setPasswordHash,
    markPasswordChanged: base.markPasswordChanged,
    unlock: (email) => unlockSignIn('user', email),
    generate: () => generateTempPassword(),
  };
}
