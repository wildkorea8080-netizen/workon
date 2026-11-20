import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-19 — 초대·도메인 가입이 기관 상태를 본다·읽기 실패는 503.
 * 예전: 정지·종료한 기관에도 초대·도메인 가입으로 새 계정이 만들어졌고(인원 자리만 차지), 초대·부서를 못 읽으면
 * '유효하지 않은 초대 링크'(400)로 답해 정상 초대를 받은 사람이 링크가 틀린 줄 알았다. `/api/register`는 가입 여부 확인을
 * 못 읽어도 '없음'으로 보았다. 가입 화면은 초대 미리보기의 오류를 보이지 않았다.
 */

const state = {
  inv: null as null | Record<string, unknown>,
  invError: null as unknown,
  dept: null as null | Record<string, unknown>,
  deptError: null as unknown,
  userError: null as unknown,
  inserts: [] as string[],
  claims: 0,
};

vi.mock('@/lib/invitation-claim', () => ({
  claimInvitation: vi.fn(async () => { state.claims++; return '2026-11-19T00:00:00Z'; }),
  releaseInvitation: vi.fn(async () => {}),
  invitationEmailMatches: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(),
}));
vi.mock('@/lib/user-seats', () => ({ checkUserSeats: vi.fn(async () => ({ ok: true })), seatErrorBody: () => ({}) }));
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { signUp: vi.fn() } } }));
vi.mock('@/lib/config', () => ({ APP_URL: 'http://x' }));
vi.mock('bcryptjs', () => ({ default: { hash: async () => 'hash' } }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    auth: { admin: { createUser: vi.fn(async () => ({ data: { user: { id: 'u-new' } }, error: null })), deleteUser: vi.fn(async () => ({})) } },
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'order']) b[n] = () => b;
      b.insert = () => { state.inserts.push(table); return b; };
      const respond = () => {
        if (table === 'invitations') return { data: state.invError ? null : state.inv, error: state.invError };
        if (table === 'departments') return { data: state.deptError ? null : state.dept, error: state.deptError };
        if (table === 'users') {
          if (state.inserts.includes('users')) return { data: { id: 'u-new', email: 'a@x.go.kr', role: 'USER' }, error: null };
          return { data: null, error: state.userError };
        }
        return { data: null, error: null };
      };
      b.maybeSingle = async () => respond();
      b.single = async () => respond();
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(res);
      return b;
    },
  },
}));

import { departmentOrgRejection, departmentOrgState, STOPPED_ORG_SIGNUP_MESSAGE } from '@/lib/signup-org';
import { POST as signup } from '@/app/api/signup/route';
import { POST as register } from '@/app/api/register/route';
import { GET as inviteInfo } from '@/app/api/signup/invite-info/route';

const future = new Date(Date.now() + 86_400_000).toISOString();
const post = (body: unknown) => new Request('http://x/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) as never;
const signupBody = { email: 'a@x.go.kr', password: 'Passw0rd!', confirmPassword: 'Passw0rd!', fullName: '가', inviteToken: 't1' };

beforeEach(() => {
  state.inv = { id: 'i1', email: 'a@x.go.kr', role: 'USER', department_id: 'd1', expires_at: future, accepted_at: null };
  state.invError = null;
  state.dept = { id: 'd1', organizations: { name: '가 기관', status: 'active' } };
  state.deptError = null; state.userError = null; state.inserts = []; state.claims = 0;
});

describe('departmentOrgState', () => {
  it('활성·멈춤·없음·못 읽음', async () => {
    expect(await departmentOrgState('d1')).toEqual({ kind: 'ok', orgName: '가 기관' });
    state.dept = { id: 'd1', organizations: [{ name: '가 기관', status: 'terminated' }] };
    expect(await departmentOrgState('d1')).toEqual({ kind: 'stopped', orgName: '가 기관' });
    state.dept = null;
    expect(await departmentOrgState('d1')).toEqual({ kind: 'missing' });
    state.deptError = { code: 'XX000' };
    expect(await departmentOrgState('d1')).toEqual({ kind: 'error' });
    expect([departmentOrgRejection({ kind: 'stopped', orgName: null })?.status, departmentOrgRejection({ kind: 'missing' })?.status,
      departmentOrgRejection({ kind: 'error' })?.status, departmentOrgRejection({ kind: 'ok', orgName: null })]).toEqual([403, 400, 503, null]);
  });
});

describe('POST /api/signup (초대)', () => {
  it('정지한 기관이면 403 — 초대를 차지하지도 계정을 만들지도 않음', async () => {
    state.dept = { id: 'd1', organizations: { name: '가', status: 'suspended' } };
    const res = await signup(post(signupBody));
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toBe(STOPPED_ORG_SIGNUP_MESSAGE);
    expect(state.claims).toBe(0);
    expect(state.inserts).toEqual([]);
  });
  it('초대·부서를 못 읽으면 400이 아니라 503', async () => {
    state.invError = { code: 'XX000' };
    expect((await signup(post(signupBody))).status).toBe(503);
    state.invError = null; state.deptError = { code: 'XX000' };
    expect((await signup(post(signupBody))).status).toBe(503);
    expect(state.claims).toBe(0);
  });
  it('활성 기관이면 가입', async () => {
    expect((await signup(post(signupBody))).status).toBe(201);
  });
});

describe('POST /api/register', () => {
  const body = { token: 't1', name: '가', password: 'Passw0rd!' };
  it('종료한 기관 403·초대 못 읽음 503·가입 여부 못 읽음 503', async () => {
    state.dept = { id: 'd1', organizations: { name: '가', status: 'terminated' } };
    expect((await register(post(body))).status).toBe(403);
    state.dept = { id: 'd1', organizations: { name: '가', status: 'active' } };
    state.invError = { code: 'XX000' };
    expect((await register(post(body))).status).toBe(503);
    state.invError = null; state.userError = { code: 'XX000' };
    expect((await register(post(body))).status).toBe(503);
    expect(state.claims).toBe(0);
  });
  it('없는 초대는 400, 활성 기관이면 가입', async () => {
    state.inv = null;
    expect((await register(post(body))).status).toBe(400);
    state.inv = { id: 'i1', email: 'a@x.go.kr', role: 'USER', department_id: 'd1', expires_at: future, accepted_at: null };
    expect((await register(post(body))).status).toBe(200);
  });
});

describe('GET /api/signup/invite-info', () => {
  const get = () => inviteInfo(new Request('http://x/?token=t1') as never);
  it('멈춘 기관·못 읽음을 미리 알림', async () => {
    expect(await (await get()).json()).toMatchObject({ ok: true, data: { orgName: '가 기관' } });
    state.dept = { id: 'd1', organizations: { name: '가', status: 'terminated' } };
    const r = await get();
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe(STOPPED_ORG_SIGNUP_MESSAGE);
    state.invError = { code: 'XX000' };
    expect((await get()).status).toBe(503);
  });
});

describe('원본 확인', () => {
  it('도메인 가입도 기관 상태를 보고 읽기 실패를 가른다', () => {
    const s = readFileSync('src/app/api/signup/route.ts', 'utf8');
    expect(s).toContain("if (isStoppedOrgStatus(org.status)) return 'stopped';");
    expect(s).toContain("if (resolved === 'error' || resolved === 'stopped')");
  });
  it('가입 화면은 초대 미리보기 오류를 보인다', () => {
    const s = readFileSync('src/app/signup/page.tsx', 'utf8');
    expect(s).toContain('encodeURIComponent(inviteToken)');
    expect(s).toContain("} else if (typeof d?.error === 'string') {");
  });
});
