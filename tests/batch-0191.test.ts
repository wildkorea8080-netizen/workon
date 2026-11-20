import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-19 — 초대 없는(도메인) 가입은 소속을 Auth 계정보다 먼저 정한다.
 * 예전: `supabase.auth.signUp`으로 계정을 만들고 **가입 확인 메일을 보낸 뒤에야** 도메인으로 기관을 찾아, 소속이 없는 이메일·
 * 멈춘 기관·인원 상한이어도 확인 메일이 나갔고 만든 Auth 계정을 다시 지웠다.
 */

const state = {
  org: null as null | { id: string; status: string },
  orgError: null as unknown,
  depts: [] as Array<{ id: string; parent_id: string | null }>,
  seatsOk: true,
  inserts: [] as Array<Record<string, unknown>>,
};
const { signUp, deleteUser } = vi.hoisted(() => ({
  signUp: vi.fn(async () => ({ data: { user: { id: 'u-new' } }, error: null })),
  deleteUser: vi.fn(async () => ({})),
}));

vi.mock('@/lib/invitation-claim', () => ({ claimInvitation: vi.fn(), releaseInvitation: vi.fn(), invitationEmailMatches: () => true }));
vi.mock('@/lib/user-seats', () => ({
  checkUserSeats: vi.fn(async () => (state.seatsOk ? { ok: true } : { ok: false, status: 403 })),
  seatErrorBody: () => ({ ok: false, error: { message: '상한' } }),
}));
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { signUp } } }));
vi.mock('@/lib/config', () => ({ APP_URL: 'http://x' }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    auth: { admin: { deleteUser, createUser: vi.fn() } },
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'order']) b[n] = () => b;
      b.insert = async (row: Record<string, unknown>) => { state.inserts.push(row); return { error: null }; };
      b.maybeSingle = async () => (table === 'organizations' ? { data: state.orgError ? null : state.org, error: state.orgError } : { data: null, error: null });
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(table === 'departments' ? { data: state.depts, error: null } : { data: null, error: null }).then(res);
      return b;
    },
  },
}));

import { POST } from '@/app/api/signup/route';

const post = (email: string) => POST(new Request('http://x/', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: 'Passw0rd!', confirmPassword: 'Passw0rd!', fullName: '가' }),
}));

beforeEach(() => {
  state.org = { id: 'o1', status: 'active' }; state.orgError = null;
  state.depts = [{ id: 'd-sub', parent_id: 'd-top' }, { id: 'd-top', parent_id: null }];
  state.seatsOk = true; state.inserts = [];
  signUp.mockClear(); deleteUser.mockClear();
});

describe('도메인 가입 — Auth 계정보다 소속 먼저', () => {
  it('도메인 기관이 없으면 403 — 확인 메일(signUp) 없음', async () => {
    state.org = null;
    expect((await post('a@nowhere.kr')).status).toBe(403);
    expect(signUp).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });
  it('멈춘 기관 403·못 읽음 503·인원 상한 — 모두 signUp 전에', async () => {
    state.org = { id: 'o1', status: 'terminated' };
    expect((await post('a@x.go.kr')).status).toBe(403);
    state.org = { id: 'o1', status: 'active' }; state.orgError = { code: 'XX000' };
    expect((await post('a@x.go.kr')).status).toBe(503);
    state.orgError = null; state.seatsOk = false;
    expect((await post('a@x.go.kr')).status).toBe(403);
    expect(signUp).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });
  it('기관이 있으면 최상위 부서로 가입', async () => {
    expect((await post('a@x.go.kr')).status).toBe(201);
    expect(signUp).toHaveBeenCalledTimes(1);
    expect(state.inserts[0]).toMatchObject({ id: 'u-new', department_id: 'd-top', role: 'USER' });
  });
});

describe('원본 확인', () => {
  it('도메인 소속을 찾는 곳은 signUp보다 앞', () => {
    const s = readFileSync('src/app/api/signup/route.ts', 'utf8');
    const resolve = s.indexOf('const resolved = await resolveDepartmentByEmailDomain(email);');
    expect(resolve).toBeGreaterThan(0);
    expect(resolve).toBeLessThan(s.indexOf('await supabase.auth.signUp('));
    expect(s.match(/resolveDepartmentByEmailDomain\(email\)/g)).toHaveLength(1);
  });
});
