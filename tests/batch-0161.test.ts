import { readFileSync } from 'fs';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-18 — 부서 삭제(`DELETE /api/departments/[id]`).
 * 부서 행을 지우면 DB가 그 부서의 대화·문서를 함께 지우고(CASCADE) 직원·사용 기록·보안 로그의 부서 칸을 비운다(SET NULL).
 * 예전 검사는 하위 부서·직원·비서 수만 봤고, **수를 못 읽으면 '없음'으로 보고 지웠다.**
 */

type Call = { table: string; ops: Array<[string, unknown[]]> };
type Result = { data?: unknown; error: unknown; count?: number | null };
const ERR = { code: 'XX000', message: 'boom' };

const D_SELF = 'd-self';
const D_CHILD = 'd-child';
const D_OTHER = 'd-other';

const state: {
  session: unknown;
  calls: Call[];
  /** from() 호출마다 답을 정한다 — null이면 기본 답 */
  respond: (c: Call) => Result | null;
  managed: string[];
} = { session: null, calls: [], respond: () => null, managed: [D_SELF, D_CHILD] };

const did = (c: Call, name: string) => c.ops.some(([n]) => n === name);
const has = (c: Call, name: string, ...args: unknown[]) => c.ops.some(([n, a]) => n === name && JSON.stringify(a) === JSON.stringify(args));
const isCount = (c: Call) => c.ops.some(([n, a]) => n === 'select' && (a as unknown[])[1] && ((a as unknown[])[1] as { head?: boolean }).head === true);

function fallback(c: Call): Result {
  if (did(c, 'delete')) return { data: null, error: null };
  if (did(c, 'update') || did(c, 'insert')) return { data: { id: D_CHILD, name: '바꾼 이름', parent_id: D_SELF }, error: null };
  if (isCount(c)) return { data: null, error: null, count: 0 };
  if (did(c, 'maybeSingle')) {
    // 요청자의 부서(기관·상위) 또는 대상 부서
    if (c.ops.some(([n, a]) => n === 'select' && (a as unknown[])[0] === 'organization_id, parent_id')) {
      return { data: { organization_id: 'org1', parent_id: null }, error: null };
    }
    const id = (c.ops.find(([n, a]) => n === 'eq' && (a as unknown[])[0] === 'id')?.[1] as unknown[])?.[1];
    return { data: { id, name: '총무과', parent_id: D_SELF }, error: null };
  }
  if (did(c, 'range')) return { data: [], error: null, count: 0 };
  return { data: [], error: null };
}
const resolve = (c: Call): Result => state.respond(c) ?? fallback(c);

vi.mock('@/lib/auth', () => ({
  getServerAuthSession: async () => state.session,
  isAdminSession: (s: { user?: { role?: string } } | null) => s?.user?.role === 'ADMIN',
}));
vi.mock('@/lib/security-log', () => ({ logSecurityEvent: async () => true }));
vi.mock('@/lib/department-scope', () => ({
  getManagedDepartmentIds: async () => state.managed,
  departmentDescendantsStrict: async () => [],
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

import { GET, POST } from '@/app/api/departments/route';
import { DELETE, PATCH } from '@/app/api/departments/[id]/route';
import { checkDepartmentDelete, departmentDeleteMessage, DEPARTMENT_RECORD_TABLES } from '@/lib/department-delete';

// 두 라우트의 핸들러는 형식상 undefined를 돌려줄 수 있는 꼴이라(권한 실패 갈래의 합집합) 시험에서는 응답이 있다고 본다
const badJson = { json: async () => { throw new Error('bad'); } } as never;
const del = async (id = D_CHILD) => (await DELETE({} as never, { params: { id } }))!;
const patchReq = async (req: never, id = D_CHILD) => (await PATCH(req, { params: { id } }))!;
const patch = (body: unknown, id = D_CHILD) => patchReq({ json: async () => body } as never, id);
const get = async () => (await GET())!;
const post = async (req: never) => (await POST(req))!;
const deletes = () => state.calls.filter((c) => did(c, 'delete'));
const writes = () => state.calls.filter((c) => did(c, 'delete') || did(c, 'update') || did(c, 'insert'));

beforeEach(() => {
  state.session = { user: { id: 'admin1', role: 'ADMIN', departmentId: D_SELF } };
  state.calls = [];
  state.respond = () => null;
  state.managed = [D_SELF, D_CHILD];
});

describe('checkDepartmentDelete — 남은 것 세기', () => {
  it('아무것도 없으면 지울 수 있다', async () => {
    const check = await checkDepartmentDelete(D_CHILD);
    expect(check).toEqual({ ok: true, blockers: [], records: [] });
    expect(departmentDeleteMessage({ blockers: [], records: [] })).toBeNull();
  });

  it('직원·비서는 보이는 것과 안 보이는 것(탈퇴 계정·지운 비서)을 갈라 센다', async () => {
    await checkDepartmentDelete(D_CHILD);
    const users = state.calls.filter((c) => c.table === 'users');
    const agents = state.calls.filter((c) => c.table === 'agents');
    for (const pair of [users, agents]) {
      expect(pair).toHaveLength(2);
      expect(pair.filter((c) => has(c, 'is', 'deleted_at', null))).toHaveLength(1);
      expect(pair.filter((c) => has(c, 'not', 'deleted_at', 'is', null))).toHaveLength(1);
      expect(pair.every((c) => has(c, 'eq', 'department_id', D_CHILD))).toBe(true);
    }
    expect(has(state.calls.find((c) => c.table === 'departments')!, 'eq', 'parent_id', D_CHILD)).toBe(true);
    expect(has(state.calls.find((c) => c.table === 'invitations')!, 'not', 'accepted_at', 'is', null)).toBe(true);
  });

  it('옮기면 없어지는 것은 blockers, 지우지 않는 기록은 records', async () => {
    state.respond = (c) => {
      if (c.table === 'departments' && isCount(c)) return { error: null, count: 2 };
      if (c.table === 'users' && has(c, 'is', 'deleted_at', null)) return { error: null, count: 3 };
      if (c.table === 'users') return { error: null, count: 1 };
      if (c.table === 'agents' && has(c, 'not', 'deleted_at', 'is', null)) return { error: null, count: 4 };
      if (c.table === 'conversations' || c.table === 'usage_logs') return { data: [{ department_id: D_CHILD }], error: null };
      return null;
    };
    const check = await checkDepartmentDelete(D_CHILD);
    expect(check).toEqual({
      ok: true,
      blockers: ['하위 부서 2개', '소속 직원 3명'],
      records: ['탈퇴 처리된 계정 1개', '지운 비서 4개', '대화', '사용 기록'],
    });
    if (!check.ok) return;
    expect(departmentDeleteMessage(check)).toContain('하위 부서 2개, 소속 직원 3명');
    const kept = departmentDeleteMessage({ blockers: [], records: check.records })!;
    expect(kept).toContain('대화');
    expect(kept).toContain('기록은 지우지 않습니다');
  });

  it('수를 하나라도 못 읽으면 ok:false — 오류든, 수가 숫자로 오지 않든, 기록 조회 실패든', async () => {
    state.respond = (c) => (c.table === 'users' && isCount(c) ? { error: ERR, count: null } : null);
    expect(await checkDepartmentDelete(D_CHILD)).toEqual({ ok: false });

    state.respond = (c) => (c.table === 'agents' && isCount(c) ? { error: null, count: null } : null);
    expect(await checkDepartmentDelete(D_CHILD)).toEqual({ ok: false });

    state.respond = (c) => (c.table === 'usage_logs' ? { data: null, error: ERR } : null);
    expect(await checkDepartmentDelete(D_CHILD)).toEqual({ ok: false });
  });
});

describe('DELETE /api/departments/[id]', () => {
  it('남은 것이 없으면 내 기관의 그 부서만 지운다', async () => {
    const res = await del();
    expect(res.status).toBe(200);
    const d = deletes();
    expect(d).toHaveLength(1);
    expect(d[0].table).toBe('departments');
    expect(has(d[0], 'eq', 'id', D_CHILD)).toBe(true);
    expect(has(d[0], 'eq', 'organization_id', 'org1')).toBe(true);
  });

  it('남은 것을 못 세면 지우지 않는다(503) — 예전에는 "없음"으로 보고 지웠다', async () => {
    state.respond = (c) => (c.table === 'users' && isCount(c) ? { error: ERR, count: null } : null);
    const res = await del();
    expect(res.status).toBe(503);
    expect(deletes()).toHaveLength(0);
  });

  it('직원·비서를 옮긴 "빈" 부서여도 대화·사용 기록이 남았으면 지우지 않는다(409)', async () => {
    state.respond = (c) => (c.table === 'conversations' ? { data: [{ department_id: D_CHILD }], error: null } : null);
    const res = await del();
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toContain('이 부서로 남은 기록(대화)');
    expect(deletes()).toHaveLength(0);
  });

  it('소속 직원이 남았으면 409', async () => {
    state.respond = (c) => (c.table === 'users' && has(c, 'is', 'deleted_at', null) ? { error: null, count: 1 } : null);
    const res = await del();
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toContain('소속 직원 1명');
    expect(deletes()).toHaveLength(0);
  });

  it('DB가 막으면(23503) 이유를 알린다', async () => {
    state.respond = (c) => (did(c, 'delete') ? { data: null, error: { code: '23503', message: 'fk' } } : null);
    const res = await del();
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toContain('가리키는 기록');
  });

  it('대상을 못 읽으면 404가 아니라 503, 관리 범위 밖은 읽지 않고 404, 내 부서는 400', async () => {
    state.respond = (c) => (c.table === 'departments' && has(c, 'eq', 'id', D_CHILD) && did(c, 'maybeSingle') ? { data: null, error: ERR } : null);
    expect((await del()).status).toBe(503);

    state.respond = () => null;
    state.calls = [];
    expect((await del(D_OTHER)).status).toBe(404);
    expect(state.calls.some((c) => has(c, 'eq', 'id', D_OTHER))).toBe(false);

    expect((await del(D_SELF)).status).toBe(400);
    expect(deletes()).toHaveLength(0);
  });

  it('요청자의 부서를 못 읽으면 503', async () => {
    state.respond = (c) => (c.table === 'departments' && has(c, 'eq', 'id', D_SELF) ? { data: null, error: ERR } : null);
    expect((await del()).status).toBe(503);
    expect((await get()).status).toBe(503);
  });
});

describe('PATCH·POST — 요청 형식과 읽기 실패', () => {
  it('깨진 요청은 400', async () => {
    expect((await patchReq(badJson)).status).toBe(400);
    expect((await patch([])).status).toBe(400);
    expect((await post(badJson)).status).toBe(400);
    expect(writes()).toHaveLength(0);
  });

  it('상위 부서를 못 읽으면 "없음"(400)이 아니라 503', async () => {
    state.managed = [D_SELF, D_CHILD, 'd-parent'];
    state.respond = (c) => (c.table === 'departments' && has(c, 'eq', 'id', 'd-parent') ? { data: null, error: ERR } : null);
    const res = await patch({ parent_id: 'd-parent' });
    expect(res.status).toBe(503);
    expect(writes()).toHaveLength(0);
  });

  it('이름 바꾸기는 그대로 된다', async () => {
    const res = await patch({ name: ' 바꾼 이름 ' });
    expect(res.status).toBe(200);
    const w = writes();
    expect(w).toHaveLength(1);
    expect(w[0].ops.find(([n]) => n === 'update')?.[1]).toEqual([{ name: '바꾼 이름' }]);
  });
});

describe('GET /api/departments — 인원·비서 수', () => {
  const rows = [{ id: D_SELF, name: '본부', parent_id: null, description: null }, { id: D_CHILD, name: '총무과', parent_id: D_SELF, description: null }];
  const listed = (c: Call) => c.table === 'departments' && did(c, 'in') && !did(c, 'maybeSingle');

  it('탈퇴 계정·지운 비서를 빼고 센다', async () => {
    state.respond = (c) => {
      if (listed(c)) return { data: rows, error: null };
      if (c.table === 'users' && did(c, 'range')) return { data: [{ department_id: D_CHILD }, { department_id: D_CHILD }], error: null, count: 2 };
      if (c.table === 'agents' && did(c, 'range')) return { data: [{ department_id: D_SELF }], error: null, count: 1 };
      return null;
    };
    const body = await (await get()).json();
    expect(body.data[0]).toMatchObject({ id: D_SELF, userCount: 0, agentCount: 1 });
    expect(body.data[0].children[0]).toMatchObject({ id: D_CHILD, userCount: 2, agentCount: 0 });
    for (const table of ['users', 'agents']) {
      const c = state.calls.find((x) => x.table === table && did(x, 'range'))!;
      expect(has(c, 'is', 'deleted_at', null)).toBe(true);
    }
  });

  it('수를 못 읽으면 0이 아니라 null, 목록은 그대로', async () => {
    state.respond = (c) => {
      if (listed(c)) return { data: rows, error: null };
      if (c.table === 'users' && did(c, 'range')) return { data: null, error: ERR };
      return null;
    };
    const body = await (await get()).json();
    expect(body.ok).toBe(true);
    expect(body.data[0].userCount).toBeNull();
    expect(body.data[0].agentCount).toBe(0);
  });
});

describe('원본 확인', () => {
  it('삭제 라우트는 수를 직접 세지 않고 checkDepartmentDelete를 쓴다', () => {
    const src = readFileSync('src/app/api/departments/[id]/route.ts', 'utf8');
    expect(src).toContain('await checkDepartmentDelete(target.id)');
    expect(src).not.toContain('{ count: childCount }');
    for (const p of ['src/app/api/departments/[id]/route.ts', 'src/app/api/departments/route.ts', 'src/lib/department-delete.ts']) {
      expect(readFileSync(p, 'utf8')).not.toMatch(/const \{ data(: \w+)? \} = await supabaseAdmin/);
    }
  });

  it('화면은 null 수를 0으로 보이지 않는다', () => {
    const ui = readFileSync('src/components/admin/DepartmentsManager.tsx', 'utf8');
    expect(ui).toContain("{node.userCount ?? '—'}");
    expect(ui).toContain("{node.agentCount ?? '—'}");
  });
});

/**
 * 부서를 가리키는 표가 늘면 여기서 걸린다 — 새 표를 '기록'으로 볼지(DEPARTMENT_RECORD_TABLES) 따로 다룰지(아래 목록에 이유와 함께) 정해야 한다.
 * 빠뜨리면 부서를 지울 때 그 표의 행이 조용히 함께 지워지거나 부서 칸이 빈다.
 */
const HANDLED_ELSEWHERE = new Map<string, string>([
  ['departments', '하위 부서 수로 막는다'],
  ['users', '소속 직원·탈퇴 처리된 계정 수로 막는다'],
  ['agents', '비서·지운 비서 수로 막는다'],
  ['invitations', '수락된 초대만 막는다 — 기다리는 초대는 부서와 함께 지워도 된다(링크가 못 쓰게 될 뿐)'],
  ['forbidden_words', '그 부서(와 하위)에만 걸리는 설정이라 부서와 함께 지운다'],
  ['report_templates', '옛 보고서 템플릿(읽기 전용) — 부서와 함께 지운다'],
]);

const url = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!url)('시험 DB — 부서를 가리키는 표를 빠짐없이 다룬다', () => {
  let db: pg.Client;
  beforeAll(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  it('부서 외래 키가 있는 표는 기록 목록에 있거나, 따로 다루는 이유가 적혀 있다', async () => {
    const { rows } = await db.query(`
      select distinct cl.relname as tbl
        from pg_constraint con
        join pg_class cl on cl.oid = con.conrelid
        join pg_class ref on ref.oid = con.confrelid
       where con.contype = 'f' and ref.relname = 'departments'
         and cl.relnamespace = 'public'::regnamespace and ref.relnamespace = 'public'::regnamespace`);
    const known = new Set([...DEPARTMENT_RECORD_TABLES.map((t) => t.table), ...HANDLED_ELSEWHERE.keys()]);
    const missing = rows.map((r: { tbl: string }) => r.tbl).filter((t: string) => !known.has(t));
    expect(missing).toEqual([]);
  });

  it('기록 표에는 모두 department_id 칸이 있다', async () => {
    const { rows } = await db.query(
      `select table_name from information_schema.columns where table_schema = 'public' and column_name = 'department_id'`,
    );
    const withColumn = new Set(rows.map((r: { table_name: string }) => r.table_name));
    expect(DEPARTMENT_RECORD_TABLES.map((t) => t.table).filter((t) => !withColumn.has(t))).toEqual([]);
  });
});
