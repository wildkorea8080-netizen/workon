import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-18 — 기관 관리자의 직원 초대(`/api/admin/invite`). 누군가를 **관리자로** 초대해도 어디에도 남지 않았고, 취소는 수락된 초대까지 지워
 * 마지막 흔적(초대 행)도 사라졌다. 가입 여부·초대 여부 확인은 `.single()`이라 읽기 실패를 '없음'으로 봤고, 이메일 꼴도 보지 않았다.
 */

type Call = { table: string; ops: Array<[string, unknown[]]> };
const state: {
  session: unknown;
  calls: Call[];
  users: { data: unknown; error: unknown };
  invites: { data: unknown; error: unknown };
  inserted: { data: unknown; error: unknown };
  removed: { data: unknown; error: unknown };
  listed: { data: unknown; error: unknown };
  seats: unknown;
  logs: Array<{ type: string; details: Record<string, unknown>; severity: string; dept: unknown; user: unknown }>;
  mails: Array<Record<string, unknown>>;
} = {
  session: null, calls: [], users: { data: [], error: null }, invites: { data: [], error: null },
  inserted: { data: null, error: null }, removed: { data: [], error: null }, listed: { data: [], error: null },
  seats: { ok: true, used: 1, limit: 20, remaining: 19 }, logs: [], mails: [],
};

const MANAGED = ['d1', 'd2'];

vi.mock('@/lib/auth', () => ({
  getServerAuthSession: async () => state.session,
  isAdminSession: (s: { user?: { role?: string } } | null) => s?.user?.role === 'ADMIN',
}));
vi.mock('@/lib/config', () => ({ APP_URL: 'https://app.test' }));
vi.mock('@/lib/department-scope', () => ({ getManagedDepartmentIds: async () => MANAGED }));
vi.mock('@/lib/mailer', () => ({
  sendInvitationEmail: async (m: Record<string, unknown>) => { state.mails.push(m); return { sent: true }; },
}));
vi.mock('@/lib/user-seats', () => ({ SEAT_LIMIT_CODE: 'SEAT_LIMIT', checkUserSeats: async () => state.seats }));
vi.mock('@/lib/security-log', () => ({
  logSecurityEvent: async (dept: unknown, user: unknown, type: string, details: Record<string, unknown>, severity: string) => {
    state.logs.push({ dept, user, type, details, severity });
    return true;
  },
}));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const call: Call = { table, ops: [] };
      state.calls.push(call);
      const did = (n: string) => call.ops.some(([name]) => name === n);
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'in', 'is', 'gt', 'order', 'limit', 'insert', 'delete']) b[n] = (...args: unknown[]) => { call.ops.push([n, args]); return b; };
      b.single = async () => state.inserted;
      b.maybeSingle = async () => ({ data: { organizations: { name: '시험 기관' } }, error: null });
      b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
        const result = table === 'users' ? state.users : did('delete') ? state.removed : did('limit') ? state.invites : state.listed;
        return Promise.resolve(result).then(ok, bad);
      };
      return b;
    },
  },
}));

import { GET, POST } from '@/app/api/admin/invite/route';
import { DELETE } from '@/app/api/admin/invite/[id]/route';
import { securityDetailParts } from '@/lib/security-event-text';

const post = (body: unknown) => POST({ json: async () => body } as never);
const del = (id = 'inv1') => DELETE({} as never, { params: { id } });
const has = (c: Call, name: string, ...args: unknown[]) => c.ops.some(([n, a]) => n === name && JSON.stringify(a) === JSON.stringify(args));
const inserts = () => state.calls.filter((c) => c.ops.some(([n]) => n === 'insert'));
const ERR = { code: 'XX000', message: 'boom' };

beforeEach(() => {
  state.session = { user: { id: 'admin1', role: 'ADMIN', departmentId: 'd1' } };
  state.calls = [];
  state.logs = [];
  state.mails = [];
  state.users = { data: [], error: null };
  state.invites = { data: [], error: null };
  state.inserted = { data: { id: 'inv1', email: 'new@x.kr', role: 'USER', expires_at: '2026-11-25T00:00:00Z', created_at: '2026-11-18T00:00:00Z' }, error: null };
  state.removed = { data: [{ id: 'inv1', email: 'new@x.kr', role: 'ADMIN' }], error: null };
  state.listed = { data: [{ id: 'inv1' }], error: null };
  state.seats = { ok: true, used: 1, limit: 20, remaining: 19 };
});

describe('POST /api/admin/invite', () => {
  it('초대를 만들면 보안 로그에 — 직원은 low, 초대 열쇠는 싣지 않음', async () => {
    const res = await post({ email: ' New@X.kr ' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.inviteUrl).toMatch(/^https:\/\/app\.test\/register\?token=/);
    expect(body.data.invitation).not.toHaveProperty('token');
    expect(state.logs).toEqual([
      { dept: 'd1', user: 'admin1', type: 'user_invited', severity: 'low', details: { invitation_id: 'inv1', invited_email: 'new@x.kr', invited_role: 'USER' } },
    ]);
    expect(JSON.stringify(state.logs)).not.toContain('token');
    expect(state.mails[0]).toMatchObject({ to: 'new@x.kr', organizationName: '시험 기관' });
  });

  it('관리자 초대는 high', async () => {
    await post({ email: 'boss@x.kr', role: 'admin' });
    expect(state.logs[0]).toMatchObject({ type: 'user_invited', severity: 'high', details: { invited_email: 'boss@x.kr', invited_role: 'ADMIN' } });
    expect(has(inserts()[0], 'insert', { email: 'boss@x.kr', department_id: 'd1', role: 'ADMIN', token: (inserts()[0].ops.find(([n]) => n === 'insert')![1][0] as { token: string }).token, invited_by: 'admin1' })).toBe(true);
  });

  it('대리 접근 중에는 관리자를 초대하지 못함 — 직원 초대는 되고 표시가 남음', async () => {
    state.session = { user: { id: 'admin1', role: 'ADMIN', departmentId: 'd1', isImpersonating: true } };
    expect((await post({ email: 'boss@x.kr', role: 'ADMIN' })).status).toBe(403);
    expect(inserts()).toEqual([]);
    expect(state.logs).toEqual([]);
    await post({ email: 'new@x.kr' });
    expect(state.logs[0].details).toMatchObject({ impersonating: true, invited_role: 'USER' });
  });

  it.each([
    [{ email: 'abc' }, '이메일 주소가 올바르지 않습니다.'],
    [{ email: 'a b@x.kr' }, '이메일 주소가 올바르지 않습니다.'],
    [{ email: `${'a'.repeat(250)}@x.kr` }, '이메일 주소가 올바르지 않습니다.'],
    [{ email: '' }, '이메일은 필수입니다.'],
    [{ email: 'a@x.kr', role: 'OWNER' }, '권한은 ADMIN 또는 USER만 가능합니다.'],
  ])('입력 %j → 400', async (body, message) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe(message);
    expect(state.calls).toEqual([]);
  });

  it('가입 여부·초대 여부를 못 읽으면 만들지 않음(500) — 실패를 없음으로 보지 않음', async () => {
    state.users = { data: null, error: ERR };
    expect((await post({ email: 'new@x.kr' })).status).toBe(500);
    state.users = { data: [], error: null };
    state.invites = { data: null, error: ERR };
    expect((await post({ email: 'new@x.kr' })).status).toBe(500);
    expect(inserts()).toEqual([]);
    expect(state.logs).toEqual([]);
  });

  it('이미 가입했거나 유효한 초대가 있으면 400', async () => {
    state.users = { data: [{ id: 'u9' }], error: null };
    expect((await (await post({ email: 'new@x.kr' })).json()).error.message).toBe('이미 가입된 이메일입니다.');
    state.users = { data: [], error: null };
    state.invites = { data: [{ id: 'i9' }], error: null };
    expect((await (await post({ email: 'new@x.kr' })).json()).error.message).toBe('이미 유효한 초대가 존재합니다.');
    expect(inserts()).toEqual([]);
  });

  it('사용자 수 상한에 닿았으면 초대를 만들지 않음 — 확인을 못 했으면 만든다', async () => {
    state.seats = { ok: false, status: 403, code: 'SEAT_LIMIT', message: '상한(20명)에 닿아…', used: 20, limit: 20 };
    const res = await post({ email: 'new@x.kr' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toEqual({ message: '상한(20명)에 닿아…', code: 'SEAT_LIMIT' });
    expect(inserts()).toEqual([]);

    state.seats = { ok: false, status: 503, code: 'SEAT_UNKNOWN', message: '확인하지 못해…' };
    expect((await post({ email: 'new@x.kr' })).status).toBe(200);
  });

  it('만들기가 실패하면 남기지 않고 메일도 보내지 않음', async () => {
    state.inserted = { data: null, error: ERR };
    expect((await post({ email: 'new@x.kr' })).status).toBe(500);
    expect(state.logs).toEqual([]);
    expect(state.mails).toEqual([]);
  });
});

describe('GET /api/admin/invite', () => {
  it('관리 범위의 초대 — 열쇠는 고르지 않음', async () => {
    const res = await GET({} as never);
    expect((await res.json()).data).toEqual([{ id: 'inv1' }]);
    const c = state.calls[0];
    expect(has(c, 'in', 'department_id', MANAGED)).toBe(true);
    expect(has(c, 'select', 'id, email, role, expires_at, accepted_at, created_at')).toBe(true);
  });
});

describe('DELETE /api/admin/invite/[id]', () => {
  it('수락하지 않은 초대만, 관리 범위에서 — 취소를 남김', async () => {
    const res = await del();
    expect(res.status).toBe(200);
    const c = state.calls[0];
    expect(has(c, 'is', 'accepted_at', null)).toBe(true);
    expect(has(c, 'in', 'department_id', MANAGED)).toBe(true);
    expect(has(c, 'eq', 'id', 'inv1')).toBe(true);
    expect(state.logs).toEqual([
      { dept: 'd1', user: 'admin1', type: 'user_invite_canceled', severity: 'low', details: { invitation_id: 'inv1', invited_email: 'new@x.kr', invited_role: 'ADMIN' } },
    ]);
  });

  it('지운 것이 없으면 404 — 성공으로 답하지 않고 남기지도 않음', async () => {
    state.removed = { data: [], error: null };
    expect((await del()).status).toBe(404);
    expect(state.logs).toEqual([]);
  });

  it('지우기 실패는 500', async () => {
    state.removed = { data: null, error: ERR };
    expect((await del()).status).toBe(500);
    expect(state.logs).toEqual([]);
  });

  it('직원은 403', async () => {
    state.session = { user: { id: 'u', role: 'USER', departmentId: 'd1' } };
    expect((await del()).status).toBe(403);
    expect((await post({ email: 'a@x.kr' })).status).toBe(403);
    expect(state.calls).toEqual([]);
  });
});

describe('감사 화면 표시', () => {
  it('초대 상세 — 이메일과 권한', () => {
    expect(securityDetailParts({ invitation_id: 'i', invited_email: 'boss@x.kr', invited_role: 'ADMIN' }, () => null)).toEqual(['초대: boss@x.kr (관리자)']);
    expect(securityDetailParts({ invited_email: 'new@x.kr', invited_role: 'USER', impersonating: true }, () => null)).toEqual(['초대: new@x.kr (일반 직원)', '대리 접근 중']);
  });
  it('이름표', () => {
    const text = readFileSync('src/lib/security-event-text.ts', 'utf8');
    expect(text).toContain("user_invited: '직원 초대(관리자)'");
    expect(text).toContain("user_invite_canceled: '직원 초대 취소(관리자)'");
  });
  it('화면 — 취소 응답을 보고 목록에서 뺌', () => {
    const ui = readFileSync('src/components/admin/UsersManager.tsx', 'utf8');
    expect(ui).toContain("if (!result?.ok) {");
    expect(ui).not.toContain("await fetch(`/api/admin/invite/${id}`, { method: 'DELETE' });\n      setInvitations");
  });
});
