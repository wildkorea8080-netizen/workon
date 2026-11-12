import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-12 — 초대 링크.
 * ① 가입(`/api/signup`)이 초대의 이메일과 가입 이메일을 맞춰 보지 않아 (관리자) 초대 링크로 아무 이메일이나 가입됐다
 * ② '이미 사용됨' 확인과 사용 표시가 따로라 같은 링크로 거의 동시에 계정 둘이 생길 수 있었다
 */

type Op = [string, unknown[]];
const state = vi.hoisted(() => ({ ops: [] as Op[], result: { data: null as unknown, error: null as unknown } }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from(table: string) {
      state.ops.push(['from', [table]]);
      const q: Record<string, unknown> = {};
      for (const m of ['update', 'eq', 'is', 'gt', 'select', 'maybeSingle']) {
        q[m] = (...args: unknown[]) => { state.ops.push([m, args]); return q; };
      }
      q.then = (resolve: (v: unknown) => unknown) => resolve(state.result);
      return q;
    },
  },
}));

import { claimInvitation, invitationEmailMatches, releaseInvitation } from '@/lib/invitation-claim';

beforeEach(() => { state.ops = []; state.result = { data: null, error: null }; });

describe('초대받은 이메일', () => {
  it('대소문자·앞뒤 공백만 다르면 같다', () => {
    expect(invitationEmailMatches('Kim@Agency.go.kr', ' kim@agency.go.kr ')).toBe(true);
  });
  it('다른 이메일·빈 값은 다르다', () => {
    expect(invitationEmailMatches('kim@agency.go.kr', 'lee@agency.go.kr')).toBe(false);
    expect(invitationEmailMatches('', '')).toBe(false);
    expect(invitationEmailMatches(null, 'kim@agency.go.kr')).toBe(false);
  });
});

describe('초대 차지', () => {
  const now = Date.parse('2026-11-12T10:00:00Z');
  it('안 썼고 만료 전인 초대만 조건부로 차지한다', async () => {
    state.result = { data: { id: 'i1' }, error: null };
    expect(await claimInvitation('i1', now)).toBe('2026-11-12T10:00:00.000Z');
    expect(state.ops).toContainEqual(['update', [{ accepted_at: '2026-11-12T10:00:00.000Z' }]]);
    expect(state.ops).toContainEqual(['eq', ['id', 'i1']]);
    expect(state.ops).toContainEqual(['is', ['accepted_at', null]]);
    expect(state.ops).toContainEqual(['gt', ['expires_at', '2026-11-12T10:00:00.000Z']]);
  });
  it('이미 썼거나(행이 안 바뀜) 오류면 차지하지 못한다', async () => {
    expect(await claimInvitation('i1', now)).toBeNull();
    state.result = { data: null, error: { message: 'x' } };
    expect(await claimInvitation('i1', now)).toBeNull();
  });
  it('푸는 것은 그 차지(같은 시각)일 때만', async () => {
    await releaseInvitation('i1', '2026-11-12T10:00:00.000Z');
    expect(state.ops).toContainEqual(['update', [{ accepted_at: null }]]);
    expect(state.ops).toContainEqual(['eq', ['accepted_at', '2026-11-12T10:00:00.000Z']]);
  });
});

describe('연결(원본)', () => {
  const signup = readFileSync('src/app/api/signup/route.ts', 'utf8');
  const register = readFileSync('src/app/api/register/route.ts', 'utf8');
  it('가입 — 이메일 확인 → 차지 → Auth 계정 만들기 순서', () => {
    const match = signup.indexOf('invitationEmailMatches(inv.email, email)');
    const claim = signup.indexOf('claimInvitation(inv.id)');
    const create = signup.indexOf('auth.admin.createUser(');
    expect(match).toBeGreaterThan(0);
    expect(claim).toBeGreaterThan(match);
    expect(create).toBeGreaterThan(claim);
  });
  it('가입 — users 행을 못 만들면 Auth 계정을 지우고 차지를 푼다', () => {
    expect(signup).toMatch(/if \(!created\) \{\s*await supabaseAdmin\.auth\.admin\.deleteUser\(authUserId\)[^\n]*\n\s*if \(inviteId && inviteClaimedAt\) await releaseInvitation/);
  });
  it('두 길 모두 사용 표시를 따로 하지 않는다(차지가 표시)', () => {
    for (const src of [signup, register]) {
      expect(src).not.toMatch(/update\(\{ accepted_at: new Date\(\)\.toISOString\(\) \}\)/);
    }
    expect(register.indexOf('claimInvitation(invitation.id)')).toBeLessThan(register.indexOf(".from('users')\n      .insert("));
    expect(register).toContain('releaseInvitation(invitation.id, claimedAt)');
  });
  it('가입 화면 — 초대에서 받은 이메일은 고치지 못한다', () => {
    const page = readFileSync('src/app/signup/page.tsx', 'utf8');
    expect(page).toContain("readOnly={type === 'email' && Boolean(inviteToken && inviteInfo?.email)}");
  });
});
