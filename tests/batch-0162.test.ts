import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-18 — 부서 만들기·고치기·삭제가 어디에도 남지 않았다. 상위 부서를 바꾸면 **누가 그 부서를 관리하는지**가 바뀌고,
 * 부서 월 한도·1인당 월 한도(기본값)는 그 부서 직원의 대화가 언제 멈추는지를 정한다(직원 한 사람의 한도 변경은 남았다).
 */

type Call = { table: string; ops: Array<[string, unknown[]]> };
type Result = { data?: unknown; error: unknown; count?: number | null };

const D_SELF = 'd-self';
const D_CHILD = 'd-child';
const D_NEW_PARENT = 'd-new-parent';

const NAMES: Record<string, string> = { [D_SELF]: '본부', [D_CHILD]: '총무과', [D_NEW_PARENT]: '기획국' };

const state: {
  session: unknown;
  calls: Call[];
  target: Record<string, unknown>;
  writeError: unknown;
  logs: Array<{ dept: unknown; user: unknown; type: string; details: Record<string, unknown>; severity: string }>;
} = { session: null, calls: [], target: {}, writeError: null, logs: [] };

const did = (c: Call, name: string) => c.ops.some(([n]) => n === name);
const eqId = (c: Call) => (c.ops.find(([n, a]) => n === 'eq' && (a as unknown[])[0] === 'id')?.[1] as unknown[] | undefined)?.[1] as string | undefined;

function resolve(c: Call): Result {
  if (did(c, 'delete')) return { data: null, error: state.writeError };
  if (did(c, 'insert')) return state.writeError ? { data: null, error: state.writeError } : { data: { id: 'd-created', name: '새 부서', parent_id: D_CHILD }, error: null };
  if (did(c, 'update')) return state.writeError ? { data: null, error: state.writeError } : { data: { id: D_CHILD }, error: null };
  if (c.ops.some(([n, a]) => n === 'select' && ((a as unknown[])[1] as { head?: boolean } | undefined)?.head)) return { error: null, count: 0 };
  if (did(c, 'maybeSingle')) {
    const select = c.ops.find(([n]) => n === 'select')?.[1][0];
    if (select === 'organization_id, parent_id') return { data: { organization_id: 'org1', parent_id: null }, error: null };
    const id = eqId(c)!;
    if (select === 'name') return { data: NAMES[id] ? { name: NAMES[id] } : null, error: null };
    if (id === D_CHILD) return { data: state.target, error: null };
    return { data: { id, name: NAMES[id] ?? '?', parent_id: null, monthly_budget_krw: null, user_monthly_budget_krw: null }, error: null };
  }
  return { data: [], error: null };
}

vi.mock('@/lib/auth', () => ({
  getServerAuthSession: async () => state.session,
  isAdminSession: (s: { user?: { role?: string } } | null) => s?.user?.role === 'ADMIN',
}));
vi.mock('@/lib/department-scope', () => ({
  getManagedDepartmentIds: async () => [D_SELF, D_CHILD, D_NEW_PARENT],
  departmentDescendantsStrict: async () => [],
}));
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
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'neq', 'is', 'not', 'in', 'order', 'limit', 'range', 'insert', 'update', 'delete']) {
        b[n] = (...args: unknown[]) => { call.ops.push([n, args]); return b; };
      }
      b.single = async () => { call.ops.push(['single', []]); return resolve(call); };
      b.maybeSingle = async () => { call.ops.push(['maybeSingle', []]); return resolve(call); };
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(resolve(call)).then(res, rej);
      return b;
    },
  },
}));

import { POST } from '@/app/api/departments/route';
import { DELETE, PATCH } from '@/app/api/departments/[id]/route';
import { departmentChanges } from '@/lib/department-audit';
import { SECURITY_EVENT_LABELS, securityDetailParts } from '@/lib/security-event-text';

const patch = async (body: unknown) => (await PATCH({ json: async () => body } as never, { params: { id: D_CHILD } }))!;
const del = async () => (await DELETE({} as never, { params: { id: D_CHILD } }))!;
const post = async (body: unknown) => (await POST({ json: async () => body } as never))!;
const noName = () => null;

beforeEach(() => {
  state.session = { user: { id: 'admin1', role: 'ADMIN', departmentId: D_SELF } };
  state.calls = [];
  state.logs = [];
  state.writeError = null;
  state.target = { id: D_CHILD, name: '총무과', parent_id: D_SELF, monthly_budget_krw: 500000, user_monthly_budget_krw: null };
});

describe('departmentChanges — 실제로 달라진 것만', () => {
  const before = { name: '총무과', parent_id: 'p1', monthly_budget_krw: 500000, user_monthly_budget_krw: null };

  it('같은 값을 다시 보내면 달라진 것이 없다', () => {
    expect(departmentChanges(before, { name: '총무과', parent_id: 'p1', monthly_budget_krw: 500000, user_monthly_budget_krw: null })).toBeNull();
    expect(departmentChanges(before, {})).toBeNull();
    // DB가 금액을 글로 돌려줘도 같은 값이면 같다
    expect(departmentChanges({ ...before, monthly_budget_krw: '500000' }, { monthly_budget_krw: 500000 })).toBeNull();
  });

  it('이름만이면 low, 한도면 medium, 상위 부서면 high', () => {
    expect(departmentChanges(before, { name: '총무팀' })).toEqual({
      changes: { from_dept_name: '총무과', to_dept_name: '총무팀' }, severity: 'low', parentChanged: false,
    });
    expect(departmentChanges(before, { monthly_budget_krw: null, user_monthly_budget_krw: 30000 })).toEqual({
      changes: { from_dept_budget_krw: 500000, to_dept_budget_krw: null, from_user_default_budget_krw: null, to_user_default_budget_krw: 30000 },
      severity: 'medium', parentChanged: false,
    });
    expect(departmentChanges(before, { name: '총무팀', monthly_budget_krw: 1, parent_id: null })).toMatchObject({
      severity: 'high', parentChanged: true, changes: { from_parent_id: 'p1', to_parent_id: null },
    });
  });
});

describe('PATCH — 부서 고치기 기록', () => {
  it('상위 부서를 바꾸면 high로, 그때의 부서 이름과 함께', async () => {
    const res = await patch({ parent_id: D_NEW_PARENT });
    expect(res.status).toBe(200);
    expect(state.logs).toEqual([{
      dept: D_SELF, user: 'admin1', type: 'department_updated', severity: 'high',
      details: {
        department_id: D_CHILD, dept_name: '총무과',
        from_parent_id: D_SELF, to_parent_id: D_NEW_PARENT, from_parent_name: '본부', to_parent_name: '기획국',
      },
    }]);
  });

  it('한도를 바꾸면 전후 값을 medium으로 — 빈 값은 제한 없음(null)', async () => {
    await patch({ monthly_budget_krw: '', user_monthly_budget_krw: 30000 });
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]).toMatchObject({
      type: 'department_updated', severity: 'medium',
      details: { from_dept_budget_krw: 500000, to_dept_budget_krw: null, from_user_default_budget_krw: null, to_user_default_budget_krw: 30000 },
    });
    expect(state.logs[0].details).not.toHaveProperty('from_parent_id');
  });

  it('같은 값을 다시 저장하면 기록하지 않는다', async () => {
    const res = await patch({ name: '총무과', monthly_budget_krw: 500000, parent_id: D_SELF });
    expect(res.status).toBe(200);
    expect(state.logs).toHaveLength(0);
  });

  it('저장에 실패하면 기록하지 않고, 대리 접근이면 표시가 남는다', async () => {
    state.writeError = { code: 'XX000', message: 'boom' };
    expect((await patch({ name: '총무팀' })).status).toBe(500);
    expect(state.logs).toHaveLength(0);

    state.writeError = null;
    state.session = { user: { id: 'admin1', role: 'ADMIN', departmentId: D_SELF, isImpersonating: true } };
    await patch({ name: '총무팀' });
    expect(state.logs[0]).toMatchObject({ severity: 'low', details: { from_dept_name: '총무과', to_dept_name: '총무팀', impersonating: true } });
  });
});

describe('POST·DELETE — 만들기·삭제 기록', () => {
  it('만들면 low로 — 새 부서 id·이름·상위 부서', async () => {
    const res = await post({ name: ' 새 부서 ', parent_id: D_CHILD });
    expect(res.status).toBe(200);
    expect(state.logs).toEqual([{
      dept: D_SELF, user: 'admin1', type: 'department_created', severity: 'low',
      details: { department_id: 'd-created', dept_name: '새 부서', parent_id: D_CHILD, parent_name: '총무과' },
    }]);
  });

  it('최상위로 만들면 상위 부서는 null', async () => {
    await post({ name: '새 본부' });
    expect(state.logs[0].details).toMatchObject({ parent_id: null, parent_name: null });
  });

  it('지우면 medium으로 — 지운 부서의 이름·상위 부서', async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(state.logs).toEqual([{
      dept: D_SELF, user: 'admin1', type: 'department_deleted', severity: 'medium',
      details: { department_id: D_CHILD, dept_name: '총무과', parent_id: D_SELF, parent_name: '본부' },
    }]);
  });

  it('만들기·삭제가 실패하면 기록하지 않는다', async () => {
    state.writeError = { code: '23505', message: 'dup' };
    expect((await post({ name: '새 부서' })).status).toBe(409);
    state.writeError = { code: 'XX000', message: 'boom' };
    expect((await del()).status).toBe(500);
    expect(state.logs).toHaveLength(0);
  });
});

describe('감사 화면의 이름표·상세', () => {
  it('세 종류 모두 이름표가 있다', () => {
    expect(SECURITY_EVENT_LABELS.department_created).toBe('부서 만들기(관리자)');
    expect(SECURITY_EVENT_LABELS.department_updated).toBe('부서 고치기(관리자)');
    expect(SECURITY_EVENT_LABELS.department_deleted).toBe('부서 삭제(관리자)');
  });

  it('고치기 — 대상·부서명·상위 부서·한도를 읽을 말로', () => {
    expect(securityDetailParts({
      department_id: 'x', dept_name: '총무과', from_dept_name: '총무과', to_dept_name: '총무팀',
      from_parent_id: 'p1', to_parent_id: null, from_parent_name: '본부', to_parent_name: null,
      from_dept_budget_krw: 500000, to_dept_budget_krw: null,
      from_user_default_budget_krw: null, to_user_default_budget_krw: 30000,
      impersonating: true,
    }, noName)).toEqual([
      '대상 부서: 총무과',
      '부서명: 총무과 → 총무팀',
      '상위 부서: 본부 → (최상위)',
      '부서 월 한도: 500,000원 → 제한 없음',
      '1인당 월 한도(부서 기본값): 제한 없음 → 30,000원',
      '대리 접근 중',
    ]);
  });

  it('만들기·삭제 — 상위 부서 한 줄, 이름을 못 읽었으면 그렇게 밝힘', () => {
    expect(securityDetailParts({ department_id: 'x', dept_name: '새 부서', parent_id: 'p1', parent_name: '총무과' }, noName))
      .toEqual(['대상 부서: 새 부서', '상위 부서: 총무과']);
    expect(securityDetailParts({ dept_name: '새 본부', parent_id: null, parent_name: null }, noName))
      .toEqual(['대상 부서: 새 본부', '상위 부서: (최상위)']);
    expect(securityDetailParts({ dept_name: '총무과', parent_id: 'p1', parent_name: null }, noName))
      .toEqual(['대상 부서: 총무과', '상위 부서: (이름 모름)']);
  });

  it('직원 기록의 풀이는 그대로(부서 옮기기·개인 한도)', () => {
    expect(securityDetailParts({ from_department_id: 'a', to_department_id: 'b', from_department_name: '총무과', to_department_name: '기획과' }, noName))
      .toEqual(['부서: 총무과 → 기획과']);
    expect(securityDetailParts({ from_budget_krw: null, to_budget_krw: 10000 }, noName))
      .toEqual(['개인 월 한도: 부서 기본값 → 10,000원']);
  });
});

describe('원본 확인', () => {
  it('세 핸들러가 쓰기에 성공한 뒤 보안 로그를 부른다', () => {
    const one = readFileSync('src/app/api/departments/[id]/route.ts', 'utf8');
    const list = readFileSync('src/app/api/departments/route.ts', 'utf8');
    expect(one).toContain("'department_updated'");
    expect(one).toContain("'department_deleted'");
    expect(list).toContain("'department_created'");
    // 고치기 전 값을 읽어야 무엇이 달라졌는지 안다
    expect(one).toContain("select('id, name, parent_id, monthly_budget_krw, user_monthly_budget_krw')");
  });
});
