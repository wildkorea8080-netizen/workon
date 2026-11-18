import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-18 — 사용자 관리(`PATCH /api/users/[id]`·`GET /api/users`·`UsersManager`).
 * - 사용자 목록에 관리자 본인도 나오고 부서 드롭다운으로 **본인을 하위 부서로 옮길 수 있었다.** 관리 범위는 자기 부서 + 하위라
 *   옮기는 순간 범위가 줄어 스스로 되돌릴 수 없다(기관 직속 관리자가 한 명뿐이면 기관 전체를 관리할 사람이 없어진다)
 * - 권한 바꾸기 API는 있었지만 화면에 단추가 없어, 직원을 관리자로 올리려면 새로 초대하거나 운영자에게 요청해야 했다
 */

type Call = { table: string; ops: Array<[string, unknown[]]> };
const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const state: {
  session: unknown;
  calls: Call[];
  target: { data: unknown; error: unknown };
  updated: { data: unknown; error: unknown };
  logs: Array<{ type: string; details: Record<string, unknown>; severity: string }>;
} = { session: null, calls: [], target: { data: null, error: null }, updated: { data: null, error: null }, logs: [] };

vi.mock('@/lib/auth', () => ({
  getServerAuthSession: async () => state.session,
  isAdminSession: (s: { user?: { role?: string } } | null) => s?.user?.role === 'ADMIN',
}));
vi.mock('@/lib/department-scope', () => ({ getManagedDepartmentIds: async () => ['d-root', 'd-sub'] }));
vi.mock('@/lib/security-log', () => ({
  logSecurityEvent: async (_d: unknown, _u: unknown, type: string, details: Record<string, unknown>, severity: string) => {
    state.logs.push({ type, details, severity });
    return true;
  },
}));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const call: Call = { table, ops: [] };
      state.calls.push(call);
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'is', 'in', 'update']) b[n] = (...args: unknown[]) => { call.ops.push([n, args]); return b; };
      b.maybeSingle = async () => state.target;
      b.single = async () => state.updated;
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve({ data: [{ id: 'd-root', name: '본부' }, { id: 'd-sub', name: '총무과' }], error: null }).then(res, rej);
      return b;
    },
  },
}));

import { PATCH } from '@/app/api/users/[id]/route';

const patch = async (id: string, body: unknown) => {
  const res = await PATCH({ json: async () => body } as never, { params: { id } });
  return { status: res.status, body: await res.json() };
};
const updates = () => state.calls.filter((c) => c.ops.some(([n]) => n === 'update'));

beforeEach(() => {
  state.session = { user: { id: ME, role: 'ADMIN', departmentId: 'd-root' } };
  state.calls = [];
  state.logs = [];
  state.target = { data: { id: ME, department_id: 'd-root', role: 'ADMIN', monthly_budget_krw: null }, error: null };
  state.updated = { data: { id: ME, email: 'me@x.kr', full_name: '나', role: 'ADMIN', department_id: 'd-root', created_at: '2026-01-01T00:00:00Z', departments: { id: 'd-root', name: '본부' } }, error: null };
});

describe('본인의 소속 부서', () => {
  it('본인을 다른 부서로 옮기지 못한다(400) — 쓰지 않고 기록도 없다', async () => {
    const out = await patch(ME, { department_id: 'd-sub' });
    expect(out.status).toBe(400);
    expect(out.body.error.message).toContain('본인의 소속 부서는 직접 옮길 수 없습니다');
    expect(updates()).toHaveLength(0);
    expect(state.logs).toHaveLength(0);
  });

  it('같은 부서를 다시 보내는 것은 막지 않는다(바뀌는 것이 없다), 본인의 개인 한도는 그대로 바꿀 수 있다', async () => {
    expect((await patch(ME, { department_id: 'd-root' })).status).toBe(200);
    expect((await patch(ME, { monthly_budget_krw: 50000 })).status).toBe(200);
    expect(state.logs.map((l) => l.type)).toEqual(['user_budget_changed']);
  });

  it('다른 직원은 관리 범위 안의 부서로 옮길 수 있고 기록이 남는다', async () => {
    state.target = { data: { id: OTHER, department_id: 'd-root', role: 'USER', monthly_budget_krw: null }, error: null };
    state.updated = { data: { id: OTHER, email: 'kim@x.kr', full_name: '김직원', role: 'USER', department_id: 'd-sub', created_at: '2026-01-01T00:00:00Z', departments: { id: 'd-sub', name: '총무과' } }, error: null };
    const out = await patch(OTHER, { department_id: 'd-sub' });
    expect(out.status).toBe(200);
    expect(updates()).toHaveLength(1);
    expect(state.logs[0]).toMatchObject({ type: 'user_department_changed', details: { target_user_id: OTHER, from_department_name: '본부', to_department_name: '총무과' } });
  });

  it('본인의 관리자 권한 해제는 예전처럼 막는다', async () => {
    expect((await patch(ME, { role: 'USER' })).status).toBe(400);
    expect(updates()).toHaveLength(0);
  });
});

describe('요청 형식', () => {
  it('깨진 요청·객체가 아닌 몸은 400(예전엔 500)', async () => {
    const res = await PATCH({ json: async () => { throw new Error('bad'); } } as never, { params: { id: OTHER } });
    expect(res.status).toBe(400);
    expect((await patch(OTHER, ['x'])).status).toBe(400);
    expect((await patch(OTHER, null)).status).toBe(400);
    expect(updates()).toHaveLength(0);
  });
});

describe('화면 — 본인 줄과 권한 단추', () => {
  const ui = readFileSync('src/components/admin/UsersManager.tsx', 'utf8');
  const api = readFileSync('src/app/api/users/route.ts', 'utf8');

  it('목록 응답이 본인 id(me)를 싣고 화면이 받는다', () => {
    expect(api).toContain('me: session.user.id');
    expect(ui).toContain("setMeId(typeof usersRes.me === 'string' ? usersRes.me : null)");
  });

  it('본인 줄은 (나)로 표시하고 부서 드롭다운을 막는다', () => {
    expect(ui).toContain('{user.id === meId && <span');
    expect(ui).toContain('disabled={movingId === user.id || depts.length === 0 || user.id === meId}');
  });

  it("'관리자로 지정/해제' 단추 — 본인·사용 중지 계정에는 없고, 확인을 받은 뒤 role을 보낸다", () => {
    expect(ui).toContain("{user.id !== meId && user.is_active !== false && (");
    expect(ui).toContain("{user.role === 'ADMIN' ? '관리자 해제' : '관리자로 지정'}");
    expect(ui).toContain("body: JSON.stringify({ role: toAdmin ? 'ADMIN' : 'USER' })");
    const handler = ui.slice(ui.indexOf('const handleRole'), ui.indexOf('const handleCopy'));
    expect(handler.indexOf('if (!confirm(question)) return;')).toBeGreaterThan(-1);
    expect(handler.indexOf('if (!confirm(question)) return;')).toBeLessThan(handler.indexOf('fetch('));
    // 실패하면 목록을 다시 읽는다
    expect(handler).toContain('await loadData();');
  });
});
