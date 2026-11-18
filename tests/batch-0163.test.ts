import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-18 — 관리자의 직원 등록(`POST /api/users`)·CSV 일괄 등록(`POST /api/admin/bulk-register`).
 * - 일괄 등록이 **관리 범위를 보지 않았다**: 기관 안의 아무 부서나 이름으로 찾아 넣어, 하위 부서 관리자가 기관 직속 부서 이름과 권한 ADMIN을
 *   적으면 기관 전체 관리자 계정이 만들어졌다(임시 비밀번호는 응답으로 받는다). 상위 없는 새 부서도 만들 수 있었다
 * - 두 길 모두 관리자 계정을 만들어도 보안 로그에 남지 않았고, 대리 접근 중에도 만들 수 있었다
 */

type Call = { table: string; ops: Array<[string, unknown[]]> };
type Result = { data?: unknown; error: unknown };
const ERR = { code: 'XX000', message: 'boom' };

const D_ROOT = 'd-root';
const D_SUB = 'd-sub';
const D_SUB_CHILD = 'd-sub-child';

const state: {
  session: unknown;
  calls: Call[];
  adminDept: Result;
  /** 기관의 부서 이름 → id */
  depts: Record<string, string>;
  deptReadError: unknown;
  existingEmails: Set<string>;
  userReadError: unknown;
  userInsertError: unknown;
  managed: string[];
  authCreated: string[];
  authDeleted: string[];
  logs: Array<{ dept: unknown; user: unknown; type: string; details: Record<string, unknown>; severity: string }>;
} = {
  session: null, calls: [], adminDept: { data: null, error: null }, depts: {}, deptReadError: null, existingEmails: new Set(),
  userReadError: null, userInsertError: null, managed: [], authCreated: [], authDeleted: [], logs: [],
};

const did = (c: Call, name: string) => c.ops.some(([n]) => n === name);
const arg = (c: Call, name: string) => c.ops.find(([n]) => n === name)?.[1];
const eqOf = (c: Call, col: string) => (c.ops.find(([n, a]) => n === 'eq' && (a as unknown[])[0] === col)?.[1] as unknown[] | undefined)?.[1];

function resolve(c: Call): Result {
  if (c.table === 'departments') {
    if (did(c, 'insert')) {
      const row = (arg(c, 'insert') as [Record<string, unknown>])[0];
      const id = `new-${row.name}`;
      state.depts[row.name as string] = id;
      return { data: { id }, error: null };
    }
    if (eqOf(c, 'name') !== undefined) {
      if (state.deptReadError) return { data: null, error: state.deptReadError };
      const id = state.depts[eqOf(c, 'name') as string];
      return { data: id ? { id } : null, error: null };
    }
    return state.adminDept;
  }
  if (c.table === 'users') {
    if (did(c, 'insert')) {
      if (state.userInsertError) return { data: null, error: state.userInsertError };
      const row = (arg(c, 'insert') as [Record<string, unknown>])[0];
      return { data: { id: (row.id as string) ?? 'u-new', email: row.email, role: row.role }, error: null };
    }
    if (state.userReadError) return { data: null, error: state.userReadError };
    return { data: state.existingEmails.has(eqOf(c, 'email') as string) ? [{ id: 'u-old' }] : [], error: null };
  }
  throw new Error(`unexpected table ${c.table}`);
}

vi.mock('@/lib/auth', () => ({
  getServerAuthSession: async () => state.session,
  isAdminSession: (s: { user?: { role?: string } } | null) => s?.user?.role === 'ADMIN',
}));
vi.mock('@/lib/config', () => ({ APP_URL: 'https://app.test' }));
vi.mock('@/lib/department-scope', () => ({ getManagedDepartmentIds: async () => state.managed }));
vi.mock('@/lib/mailer', () => ({ sendTempPasswordEmail: async () => ({ sent: false }), isMailConfigured: () => false }));
vi.mock('@/lib/user-seats', () => ({
  checkUserSeats: async () => ({ ok: true, used: 1, limit: null, remaining: null }),
  seatErrorBody: () => ({ ok: false }),
  seatUsage: async () => null,
}));
vi.mock('@/lib/sign-in-throttle', () => ({ accountLocks: async () => new Map(), lockReadDeps: () => ({}) }));
vi.mock('@/lib/paged-select', () => ({ pagedRows: async () => ({ data: [], error: null, truncated: false, total: 0 }) }));
vi.mock('bcryptjs', () => ({ default: { hash: async () => 'hashed' }, hash: async () => 'hashed' }));
vi.mock('@/lib/security-log', () => ({
  logSecurityEvent: async (dept: unknown, user: unknown, type: string, details: Record<string, unknown>, severity: string) => {
    state.logs.push({ dept, user, type, details, severity });
    return true;
  },
}));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    auth: {
      admin: {
        createUser: async ({ email }: { email: string }) => {
          state.authCreated.push(email);
          const id = `auth-${state.authCreated.length}`;
          return { data: { user: { id } }, error: null };
        },
        deleteUser: async (id: string) => { state.authDeleted.push(id); return { error: null }; },
      },
    },
    from: (table: string) => {
      const call: Call = { table, ops: [] };
      state.calls.push(call);
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'is', 'in', 'limit', 'insert']) b[n] = (...args: unknown[]) => { call.ops.push([n, args]); return b; };
      b.single = async () => resolve(call);
      b.maybeSingle = async () => resolve(call);
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(resolve(call)).then(res, rej);
      return b;
    },
  },
}));

import { POST as bulkRegister } from '@/app/api/admin/bulk-register/route';
import { POST as createUser } from '@/app/api/users/route';
import { SECURITY_EVENT_LABELS, securityDetailParts } from '@/lib/security-event-text';

type Row = { 부서명: string; 상위부서명?: string; 직원이름: string; 이메일: string; 권한: string };
const row = (over: Partial<Row> = {}): Row => ({ 부서명: '민원팀', 직원이름: '김직원', 이메일: 'kim@x.kr', 권한: 'USER', ...over });
const bulk = async (rows: Row[]) => {
  const res = await bulkRegister({ json: async () => ({ rows }) } as never);
  return { status: res.status, body: await res.json() };
};
const create = async (body: unknown) => {
  const res = await createUser({ json: async () => body } as never);
  return { status: res.status, body: await res.json() };
};
const deptInserts = () => state.calls.filter((c) => c.table === 'departments' && did(c, 'insert')).map((c) => (arg(c, 'insert') as [Record<string, unknown>])[0]);
const userInserts = () => state.calls.filter((c) => c.table === 'users' && did(c, 'insert')).map((c) => (arg(c, 'insert') as [Record<string, unknown>])[0]);
const asRootAdmin = () => {
  state.session = { user: { id: 'admin1', role: 'ADMIN', departmentId: D_ROOT } };
  state.adminDept = { data: { name: '본부', organization_id: 'org1', parent_id: null }, error: null };
  state.managed = [D_ROOT, D_SUB, D_SUB_CHILD];
};
const asSubAdmin = () => {
  state.session = { user: { id: 'admin2', role: 'ADMIN', departmentId: D_SUB } };
  state.adminDept = { data: { name: '총무과', organization_id: 'org1', parent_id: D_ROOT }, error: null };
  state.managed = [D_SUB, D_SUB_CHILD];
};

beforeEach(() => {
  state.calls = [];
  state.logs = [];
  state.authCreated = [];
  state.authDeleted = [];
  state.depts = { 본부: D_ROOT, 총무과: D_SUB, 민원팀: D_SUB_CHILD };
  state.deptReadError = null;
  state.existingEmails = new Set();
  state.userReadError = null;
  state.userInsertError = null;
  asRootAdmin();
});

describe('일괄 등록 — 관리 범위', () => {
  it('하위 부서 관리자는 관리 범위 밖 부서(기관 직속 부서)에 관리자 계정을 만들지 못한다', async () => {
    asSubAdmin();
    const { body } = await bulk([row({ 부서명: '본부', 권한: 'ADMIN' })]);
    expect(body.data.results[0]).toMatchObject({ success: false });
    expect(body.data.results[0].error).toContain('관리 범위 밖');
    expect(state.authCreated).toHaveLength(0);
    expect(userInserts()).toHaveLength(0);
    expect(state.logs).toHaveLength(0);
  });

  it('하위 부서 관리자 — 관리 범위 안 부서에는 등록되고, 상위 없는 새 부서는 자기 부서 아래에 만든다', async () => {
    asSubAdmin();
    const { body } = await bulk([row(), row({ 부서명: '새 팀', 이메일: 'lee@x.kr' })]);
    expect(body.data.summary).toMatchObject({ success: 2, fail: 0 });
    expect(userInserts().map((u) => u.department_id)).toEqual([D_SUB_CHILD, 'new-새 팀']);
    expect(deptInserts()).toHaveLength(1);
    expect(deptInserts()[0]).toMatchObject({ name: '새 팀', parent_id: D_SUB, organization_id: 'org1' });
  });

  it('하위 부서 관리자 — 상위 부서로 적은 부서도 관리 범위 안이어야 한다', async () => {
    asSubAdmin();
    const { body } = await bulk([row({ 부서명: '새 팀', 상위부서명: '본부' })]);
    expect(body.data.results[0].error).toContain('관리 범위 밖');
    expect(deptInserts()).toHaveLength(0);
    expect(state.authCreated).toHaveLength(0);
  });

  it('기관 직속 관리자 — 상위 없는 새 부서는 예전처럼 최상위로, 상위를 적으면 그 아래로', async () => {
    await bulk([row({ 부서명: '새 본부' }), row({ 부서명: '새 팀', 상위부서명: '총무과', 이메일: 'lee@x.kr' })]);
    expect(deptInserts().map((d) => [d.name, d.parent_id])).toEqual([['새 본부', null], ['새 팀', D_SUB]]);
  });

  it('부서를 못 읽으면 새로 만들지 않고 그 줄만 실패, 등록 여부를 못 읽으면 계정을 만들지 않는다', async () => {
    state.deptReadError = ERR;
    let out = await bulk([row()]);
    expect(out.body.data.results[0].error).toContain('부서를 확인하지 못했습니다');
    expect(deptInserts()).toHaveLength(0);

    state.deptReadError = null;
    state.userReadError = ERR;
    out = await bulk([row()]);
    expect(out.body.data.results[0].error).toContain('등록 여부를 확인하지 못했습니다');
    expect(state.authCreated).toHaveLength(0);
  });

  it('요청자의 부서를 못 읽으면 "기관에 연결 안 됨"(409)이 아니라 503', async () => {
    state.adminDept = { data: null, error: ERR };
    expect((await bulk([row()])).status).toBe(503);
    state.adminDept = { data: { name: '본부', organization_id: null, parent_id: null }, error: null };
    expect((await bulk([row()])).status).toBe(409);
  });
});

describe('일괄 등록 — 보안 로그', () => {
  it('관리자 계정은 하나씩 high, 전체는 수만 한 줄, 새 부서는 부서 사건으로 — 이메일·임시 비밀번호 없음', async () => {
    const { body } = await bulk([
      row({ 권한: 'ADMIN', 이메일: 'boss@x.kr' }),
      row({ 부서명: '새 팀', 상위부서명: '총무과', 이메일: 'lee@x.kr' }),
      row({ 이메일: 'not-an-email' }),
    ]);
    expect(body.data.summary).toMatchObject({ success: 2, fail: 1 });
    expect(state.logs).toEqual([
      { dept: D_ROOT, user: 'admin1', type: 'department_created', severity: 'low',
        details: { department_id: 'new-새 팀', dept_name: '새 팀', parent_id: D_SUB, parent_name: '총무과', via: 'bulk_register' } },
      { dept: D_ROOT, user: 'admin1', type: 'user_created', severity: 'high',
        details: { target_user_id: 'auth-1', created_role: 'ADMIN', via: 'bulk_register' } },
      { dept: D_ROOT, user: 'admin1', type: 'users_bulk_created', severity: 'high',
        details: { created_count: 2, created_admins: 1, created_departments: 1, failed_count: 1 } },
    ]);
    const text = JSON.stringify(state.logs);
    expect(text).not.toContain('boss@x.kr');
    for (const r of body.data.results) if (r.tempPassword) expect(text).not.toContain(r.tempPassword);
  });

  it('직원만 등록하면 요약 한 줄(low), 하나도 못 만들면 기록 없음', async () => {
    await bulk([row()]);
    expect(state.logs.map((l) => [l.type, l.severity])).toEqual([['users_bulk_created', 'low']]);

    state.logs = [];
    state.existingEmails = new Set(['kim@x.kr']);
    const { body } = await bulk([row()]);
    expect(body.data.summary.success).toBe(0);
    expect(state.logs).toHaveLength(0);
  });

  it('대리 접근 중에는 관리자 줄을 만들지 않고, 직원 줄의 기록에는 표시가 남는다', async () => {
    state.session = { user: { id: 'admin1', role: 'ADMIN', departmentId: D_ROOT, isImpersonating: true } };
    const { body } = await bulk([row({ 권한: 'ADMIN', 이메일: 'boss@x.kr' }), row()]);
    expect(body.data.results[0]).toMatchObject({ success: false });
    expect(body.data.results[0].error).toContain('대리 접근 중');
    expect(state.authCreated).toEqual(['kim@x.kr']);
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]).toMatchObject({ type: 'users_bulk_created', details: { created_count: 1, created_admins: 0, impersonating: true } });
  });

  it('직원 정보를 저장하지 못한 줄은 Auth 계정을 지우고 기록하지 않는다', async () => {
    state.userInsertError = ERR;
    const { body } = await bulk([row({ 권한: 'ADMIN' })]);
    expect(body.data.results[0].success).toBe(false);
    expect(state.authDeleted).toEqual(['auth-1']);
    expect(state.logs).toHaveLength(0);
  });
});

describe('POST /api/users — 계정 바로 만들기', () => {
  it('만들면 보안 로그에 — 직원은 low, 관리자는 high, 이메일·임시 비밀번호 없음', async () => {
    const made = await create({ email: ' kim@x.kr ', full_name: '김직원' });
    expect(made.status).toBe(200);
    expect(userInserts()[0]).toMatchObject({ email: 'kim@x.kr', role: 'USER', department_id: D_ROOT, password_must_change: true });
    expect(state.logs).toEqual([{ dept: D_ROOT, user: 'admin1', type: 'user_created', severity: 'low', details: { target_user_id: 'u-new', created_role: 'USER' } }]);

    state.logs = [];
    const admin = await create({ email: 'boss@x.kr', role: 'ADMIN' });
    expect(state.logs[0]).toMatchObject({ severity: 'high', details: { created_role: 'ADMIN' } });
    expect(JSON.stringify(state.logs)).not.toContain(admin.body.tempPassword);
    expect(JSON.stringify(state.logs)).not.toContain('boss@x.kr');
  });

  it('대리 접근 중 관리자 계정은 403, 직원 계정은 되고 표시가 남는다', async () => {
    state.session = { user: { id: 'admin1', role: 'ADMIN', departmentId: D_ROOT, isImpersonating: true } };
    expect((await create({ email: 'boss@x.kr', role: 'ADMIN' })).status).toBe(403);
    expect(userInserts()).toHaveLength(0);

    expect((await create({ email: 'kim@x.kr' })).status).toBe(200);
    expect(state.logs[0].details).toMatchObject({ impersonating: true });
  });

  it('등록 여부를 못 읽으면 "없음"으로 보지 않는다(500), 있으면 400, 그 사이 생겼으면(23505) 400', async () => {
    state.userReadError = ERR;
    expect((await create({ email: 'kim@x.kr' })).status).toBe(500);
    expect(userInserts()).toHaveLength(0);

    state.userReadError = null;
    state.existingEmails = new Set(['kim@x.kr']);
    expect((await create({ email: 'kim@x.kr' })).status).toBe(400);
    expect(userInserts()).toHaveLength(0);

    state.existingEmails = new Set();
    state.userInsertError = { code: '23505', message: 'dup' };
    const dup = await create({ email: 'kim@x.kr' });
    expect(dup.status).toBe(400);
    expect(dup.body.error.message).toBe('이미 존재하는 이메일입니다.');
    expect(state.logs).toHaveLength(0);
  });

  it('이메일 꼴·요청 형식·역할을 본다', async () => {
    expect((await create({ email: 'not-an-email' })).status).toBe(400);
    expect((await create({ email: 'kim@x.kr', role: 'SUPER' })).status).toBe(400);
    const res = await createUser({ json: async () => { throw new Error('bad'); } } as never);
    expect(res.status).toBe(400);
    expect(userInserts()).toHaveLength(0);
  });
});

describe('감사 화면의 이름표·상세', () => {
  const nameOf = (id: string) => (id === '11111111-1111-4111-8111-111111111111' ? '김직원' : null);

  it('이름표', () => {
    expect(SECURITY_EVENT_LABELS.user_created).toBe('계정 만들기(관리자)');
    expect(SECURITY_EVENT_LABELS.users_bulk_created).toBe('직원 일괄 등록(관리자)');
  });

  it('계정 만들기 — 대상·만든 권한', () => {
    expect(securityDetailParts({ target_user_id: '11111111-1111-4111-8111-111111111111', created_role: 'ADMIN', via: 'bulk_register' }, nameOf))
      .toEqual(['대상: 김직원', '만든 권한: 관리자', '일괄 등록으로']);
  });

  it('일괄 등록 — 수만', () => {
    expect(securityDetailParts({ created_count: 12, created_admins: 1, created_departments: 2, failed_count: 3 }, nameOf))
      .toEqual(['등록 12명 · 관리자 1명 · 새 부서 2개 · 실패 3줄']);
    expect(securityDetailParts({ created_count: 5, created_admins: 0, created_departments: 0, failed_count: 0, impersonating: true }, nameOf))
      .toEqual(['등록 5명', '대리 접근 중']);
  });
});
