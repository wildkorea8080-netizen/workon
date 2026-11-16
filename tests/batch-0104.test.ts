import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

const calls: { op: string; args: unknown[] }[] = [];
let deleteError: { message: string } | null = null;
vi.mock('@/lib/supabaseAdmin', () => {
  const chain = (): any => {
    const c: any = {};
    for (const m of ['delete', 'eq']) c[m] = (...args: unknown[]) => { calls.push({ op: m, args }); return c; };
    c.then = (res: (v: unknown) => void) => res({ error: deleteError });
    return c;
  };
  return { supabaseAdmin: { from: (t: string) => { calls.push({ op: 'from', args: [t] }); return chain(); } } };
});

import {
  LOCK_READ_CHUNK, LOCK_WINDOW_MS, accountLocks, lockedUntil, signInKey, unlockSignIn, type LockReadDeps,
} from '@/lib/sign-in-throttle';
import { lockUntilLabel } from '@/lib/sign-in-lock-spec';

/** 2026-11-16 — 관리자가 로그인 잠금(0091)을 보고 푼다. 예전에는 잠긴 직원이 30분을 기다려야 했다 */

const NOW = Date.parse('2026-11-16T03:00:00Z'); // KST 12:00
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

describe('잠금 풀리는 때', () => {
  it('창 안 실패가 5번 미만이면 잠기지 않음', () => {
    expect(lockedUntil([ago(1), ago(2), ago(3), ago(4)], NOW)).toBeNull();
    expect(lockedUntil([], NOW)).toBeNull();
  });
  it('5번이면 가장 오래된 실패 + 30분에 풀림(순서와 상관없이)', () => {
    expect(lockedUntil([ago(1), ago(20), ago(5), ago(10), ago(2)], NOW)).toBe(new Date(NOW - 20 * 60_000 + LOCK_WINDOW_MS).toISOString());
  });
  it('6번이면 둘째로 오래된 실패가 기준 — 그때 5번 아래로 떨어진다', () => {
    expect(lockedUntil([ago(25), ago(20), ago(5), ago(4), ago(3), ago(2)], NOW)).toBe(new Date(NOW - 20 * 60_000 + LOCK_WINDOW_MS).toISOString());
  });
  it('30분 지난 실패·읽지 못하는 시각은 세지 않음', () => {
    expect(lockedUntil([ago(31), ago(4), ago(3), ago(2), ago(1)], NOW)).toBeNull();
    expect(lockedUntil(['x', ago(4), ago(3), ago(2), ago(1)], NOW)).toBeNull();
  });
});

describe('관리 화면의 잠김 표시', () => {
  function fakeDeps(rows: { key_hash: string; created_at: string }[] | null | 'throw') {
    const seen: { scope: string; hashes: string[]; since: string }[] = [];
    const d: LockReadDeps = {
      listFailures: vi.fn(async (scope, hashes, since) => {
        seen.push({ scope, hashes, since });
        if (rows === 'throw') throw new Error('db');
        return rows === null ? null : rows.filter((r) => hashes.includes(r.key_hash));
      }),
    };
    return { d, seen };
  }
  it('잠긴 이메일만 풀리는 때와 함께, 같은 해시의 다른 표기도', async () => {
    const h = signInKey('a@b.kr');
    const { d, seen } = fakeDeps([1, 2, 3, 4, 5].map((m) => ({ key_hash: h, created_at: ago(m) })));
    const out = await accountLocks(d, 'user', ['a@b.kr', 'A@B.kr ', 'c@d.kr', null, ''], NOW);
    expect(out.get('a@b.kr')).toBe(new Date(NOW - 5 * 60_000 + LOCK_WINDOW_MS).toISOString());
    expect(out.get('A@B.kr ')).toBe(out.get('a@b.kr'));
    expect(out.has('c@d.kr')).toBe(false);
    expect(seen[0]).toMatchObject({ scope: 'user', since: new Date(NOW - LOCK_WINDOW_MS).toISOString() });
    expect(seen[0].hashes).toHaveLength(2); // 해시는 한 번씩, 빈 값은 빼고
  });
  it('해시는 100개씩 나눠 맞댄다', async () => {
    const { d, seen } = fakeDeps([]);
    await accountLocks(d, 'super', Array.from({ length: 250 }, (_, i) => `u${i}@x.kr`), NOW);
    expect(seen.map((s) => s.hashes.length)).toEqual([LOCK_READ_CHUNK, LOCK_READ_CHUNK, 50]);
  });
  it('못 읽으면 잠김 표시만 없다(던지지 않음)', async () => {
    expect((await accountLocks(fakeDeps(null).d, 'user', ['a@b.kr'], NOW)).size).toBe(0);
    expect((await accountLocks(fakeDeps('throw').d, 'user', ['a@b.kr'], NOW)).size).toBe(0);
  });
  it('풀리는 때 글 — 한국 시간, 오늘이 아니면 날짜도', () => {
    expect(lockUntilLabel('2026-11-16T03:25:00Z', NOW)).toBe('12:25 풀림');
    expect(lockUntilLabel('2026-11-16T15:10:00Z', NOW)).toBe('11/17 00:10 풀림');
    expect(lockUntilLabel('x', NOW)).toBe('잠김');
  });
});

describe('잠금 풀기', () => {
  it('그 범위·그 계정 해시의 실패만 지운다', async () => {
    calls.length = 0; deleteError = null;
    await unlockSignIn('user', ' A@B.kr');
    expect(calls).toEqual([
      { op: 'from', args: ['sign_in_failures'] },
      { op: 'delete', args: [] },
      { op: 'eq', args: ['scope', 'user'] },
      { op: 'eq', args: ['key_hash', signInKey('a@b.kr')] },
    ]);
  });
  it('지우지 못하면 던진다(화면이 실패를 안다)', async () => {
    deleteError = { message: 'boom' };
    await expect(unlockSignIn('super', 'a@b.kr')).rejects.toThrow('boom');
    deleteError = null;
  });
});

describe('연결(원본)', () => {
  it('기관 관리자 — 관리 범위 직원만, 직원 잠금만 풀고 보안 로그(이메일 없이)', () => {
    const src = readFileSync('src/app/api/users/[id]/sign-in-lock/route.ts', 'utf8');
    expect(src).toContain('isAdminSession(session)');
    expect(src).toContain('managedDeptIds.includes(target.department_id)');
    expect(src).toContain(".eq('is_super_admin', false)");
    expect(src).toContain("unlockSignIn('user', target.email)");
    expect(src).not.toContain("unlockSignIn('super'");
    expect(src).toContain("logSecurityEvent(adminDeptId, session.user.id, 'sign_in_unlocked', { target_user_id: target.id }, 'medium')");
    expect(readFileSync('src/app/api/admin/audit-logs/route.ts', 'utf8')).toContain("sign_in_unlocked: '로그인 잠금 풀기(관리자)'");
  });
  it('슈퍼관리자 — 두 잠금을 함께 풀고 기록', () => {
    const src = readFileSync('src/app/api/super/accounts/users/[id]/sign-in-lock/route.ts', 'utf8');
    expect(src).toContain('getSuperAdminFromRequest(request)');
    expect(src).toContain("unlockSignIn('user', target.email)");
    expect(src).toContain("unlockSignIn('super', target.email)");
    expect(src).toContain("action: 'sign_in_unlocked'");
  });
  it('목록 응답 셋이 풀리는 때를 싣는다(직원은 user, 슈퍼관리자는 super 잠금)', () => {
    expect(readFileSync('src/app/api/users/route.ts', 'utf8')).toContain("accountLocks(lockReadDeps(), 'user'");
    expect(readFileSync('src/app/api/super/accounts/users/route.ts', 'utf8')).toContain("accountLocks(lockReadDeps(), 'user'");
    expect(readFileSync('src/app/api/super/accounts/super-admins/route.ts', 'utf8')).toContain("accountLocks(lockReadDeps(), 'super'");
  });
  it('화면 둘은 잎 파일만 읽고 잠금 풀기 단추를 둔다', () => {
    const admin = readFileSync('src/components/admin/UsersManager.tsx', 'utf8');
    const sup = readFileSync('src/app/super/accounts/page.tsx', 'utf8');
    for (const s of [admin, sup]) {
      expect(s).toContain("from '@/lib/sign-in-lock-spec'");
      expect(s).not.toContain("from '@/lib/sign-in-throttle'");
      expect(s).toContain('잠금 풀기');
    }
    expect(admin).toContain('`/api/users/${userId}/sign-in-lock`');
    expect(sup.match(/\/api\/super\/accounts\/users\/\$\{id\}\/sign-in-lock/g)).toHaveLength(2);
    expect(readFileSync('src/lib/sign-in-lock-spec.ts', 'utf8')).not.toMatch(/^import /m);
  });
});
