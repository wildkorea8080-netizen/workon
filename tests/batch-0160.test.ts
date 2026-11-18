import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-18 — 비서 카테고리 관리(`/api/admin/agent-categories`·`[id]`).
 * - 하위 부서 관리자도 기관 전체의 카테고리를 바꾸고(이름 바꾸기·삭제는 그 이름을 쓰는 기관의 모든 비서를 함께 고친다) 있었다 → 바꾸기는 기관 전체 관리자만
 * - 이름만 바뀌고 비서를 못 옮기면 "다시 시도"라고 했는데, 다시 보내면 이름이 이미 같아 아무 일도 안 하고 성공 → 이름을 되돌린다
 * - 순서 저장이 내 기관 카테고리를 못 읽으면 아무것도 안 바꾸고 성공, 비서 수를 못 읽으면 0개(지운 비서·나만의 비서까지 셈), 부서·대상 읽기 실패는 '없음'
 */

type Call = { table: string; ops: Array<[string, unknown[]]> };
type Result = { data: unknown; error: unknown; count?: number | null };
const ok = (data: unknown, count?: number): Result => ({ data, error: null, count });
const ERR = { code: 'XX000', message: 'boom' };
const bad = (): Result => ({ data: null, error: ERR });

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const C3 = '33333333-3333-4333-8333-333333333333';

const state: {
  session: unknown;
  calls: Call[];
  dept: Result;
  list: Result;
  agentRows: Result;
  last: Result;
  created: Result;
  mine: Result;
  orderUpdate: Result;
  category: Result;
  renamed: Result;
  moved: Result;
  reverted: Result;
  deleted: Result;
  systemLogs: Array<Record<string, unknown>>;
} = {
  session: null, calls: [], dept: ok(null), list: ok([]), agentRows: ok([], 0), last: ok([]), created: ok(null), mine: ok([]),
  orderUpdate: ok(null), category: ok(null), renamed: ok([]), moved: ok(null), reverted: ok(null), deleted: ok(null), systemLogs: [],
};

const did = (c: Call, name: string) => c.ops.some(([n]) => n === name);
const arg = (c: Call, name: string) => c.ops.find(([n]) => n === name)?.[1];
const has = (c: Call, name: string, ...args: unknown[]) => c.ops.some(([n, a]) => n === name && JSON.stringify(a) === JSON.stringify(args));

function resolve(c: Call): Result {
  if (c.table === 'departments') return state.dept;
  if (c.table === 'agents') return did(c, 'update') ? state.moved : state.agentRows;
  if (c.table === 'agent_categories') {
    if (did(c, 'insert')) return state.created;
    if (did(c, 'delete')) return state.deleted;
    if (did(c, 'update')) {
      const patch = (arg(c, 'update') as [Record<string, unknown>])[0];
      if ('display_order' in patch) return state.orderUpdate;
      return did(c, 'select') ? state.renamed : state.reverted;
    }
    if (did(c, 'maybeSingle')) return state.category;
    if (did(c, 'limit')) return state.last;
    if (did(c, 'order')) return state.list;
    return state.mine;
  }
  throw new Error(`unexpected table ${c.table}`);
}

vi.mock('@/lib/auth', () => ({
  getServerAuthSession: async () => state.session,
  isAdminSession: (s: { user?: { role?: string } } | null) => s?.user?.role === 'ADMIN',
}));
vi.mock('@/lib/logger', () => ({
  logSystem: async (p: Record<string, unknown>) => { state.systemLogs.push(p); },
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

import { GET, POST, PUT } from '@/app/api/admin/agent-categories/route';
import { PATCH, DELETE } from '@/app/api/admin/agent-categories/[id]/route';
import { cleanCategoryName, CATEGORY_EDIT_ONLY, MAX_CATEGORY_NAME } from '@/lib/agent-category-admin';

const req = (body: unknown) => ({ json: async () => body }) as never;
const badJson = { json: async () => { throw new Error('bad json'); } } as never;
const patch = (body: unknown, id = C1) => PATCH(req(body), { params: { id } });
const del = (id = C1) => DELETE({} as never, { params: { id } });
const writes = () => state.calls.filter((c) => did(c, 'insert') || did(c, 'update') || did(c, 'delete'));
const on = (table: string) => state.calls.filter((c) => c.table === table);

beforeEach(() => {
  state.session = { user: { id: 'admin1', role: 'ADMIN', departmentId: 'd1' } };
  state.calls = [];
  state.systemLogs = [];
  state.dept = ok({ organization_id: 'org1', parent_id: null });
  state.list = ok([{ id: C1, name: '인사', display_order: 0 }, { id: C2, name: '회계', display_order: 1 }]);
  state.agentRows = ok([{ category: '인사' }, { category: ' 인사 ' }, { category: '없는 이름' }], 3);
  state.last = ok([{ display_order: 4 }]);
  state.created = ok({ id: C3, name: '새 분류', display_order: 5 });
  state.mine = ok([{ id: C1 }, { id: C2 }]);
  state.orderUpdate = ok(null);
  state.category = ok({ id: C1, name: '인사', display_order: 0 });
  state.renamed = ok([{ id: C1, name: '인사·복무', display_order: 0 }]);
  state.moved = ok(null);
  state.reverted = ok(null);
  state.deleted = ok(null);
});

describe('누가 — 목록은 관리자 누구나, 바꾸기는 기관 전체 관리자만', () => {
  it('관리자가 아니면 403', async () => {
    state.session = { user: { id: 'u1', role: 'USER', departmentId: 'd1' } };
    expect((await GET()).status).toBe(403);
    expect((await POST(req({ name: 'x' }))).status).toBe(403);
    expect(state.calls).toHaveLength(0);
  });

  it('부서를 못 읽으면 "기관 없음"(409)이 아니라 503', async () => {
    state.dept = bad();
    const res = await GET();
    expect(res.status).toBe(503);
    expect(on('agent_categories')).toHaveLength(0);
  });

  it('기관이 없는 부서면 409', async () => {
    state.dept = ok({ organization_id: null, parent_id: null });
    expect((await GET()).status).toBe(409);
  });

  it('하위 부서 관리자 — 목록은 보이고(canEdit false) 바꾸기 넷은 403, 쓰기 없음', async () => {
    state.dept = ok({ organization_id: 'org1', parent_id: 'd0' });
    const listed = await GET();
    expect(listed.status).toBe(200);
    expect((await listed.json()).canEdit).toBe(false);

    state.calls = [];
    const responses = [await POST(req({ name: '새 분류' })), await PUT(req({ order: [C1] })), await patch({ name: '바꿈' }), await del()];
    for (const res of responses) {
      expect(res.status).toBe(403);
      expect((await res.json()).error.message).toBe(CATEGORY_EDIT_ONLY);
    }
    expect(on('agent_categories')).toHaveLength(0);
    expect(on('agents')).toHaveLength(0);
  });
});

describe('GET — 비서 수', () => {
  it('지운 비서·나만의 비서를 빼고 세고, 기관 전체 관리자는 canEdit', async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.canEdit).toBe(true);
    expect(body.data).toEqual([
      { id: C1, name: '인사', display_order: 0, agent_count: 2 },
      { id: C2, name: '회계', display_order: 1, agent_count: 0 },
    ]);
    const counted = on('agents')[0];
    expect(has(counted, 'eq', 'organization_id', 'org1')).toBe(true);
    expect(has(counted, 'is', 'deleted_at', null)).toBe(true);
    expect(has(counted, 'neq', 'tier', 'personal')).toBe(true);
    expect(did(counted, 'range')).toBe(true);
  });

  it('비서 수를 못 읽으면 0이 아니라 null(목록은 그대로)', async () => {
    state.agentRows = bad();
    const body = await (await GET()).json();
    expect(body.ok).toBe(true);
    expect(body.data.map((c: { agent_count: unknown }) => c.agent_count)).toEqual([null, null]);
  });

  it('목록을 못 읽으면 500', async () => {
    state.list = bad();
    expect((await GET()).status).toBe(500);
  });
});

describe('POST — 추가', () => {
  it('이름을 다듬어 맨 뒤에 붙인다', async () => {
    const res = await POST(req({ name: '  새​  분류\n ' }));
    expect(res.status).toBe(201);
    const insert = state.calls.find((c) => did(c, 'insert'))!;
    expect(arg(insert, 'insert')).toEqual([{ organization_id: 'org1', name: '새 분류', display_order: 5 }]);
  });

  it('마지막 순서를 못 읽으면 맨 앞(0)에 끼우지 않고 멈춘다', async () => {
    state.last = bad();
    expect((await POST(req({ name: '새 분류' }))).status).toBe(500);
    expect(writes()).toHaveLength(0);
  });

  it('겹친 이름 409 · 빈 이름·깨진 요청 400', async () => {
    state.created = { data: null, error: { code: '23505', message: 'dup' } };
    expect((await POST(req({ name: '인사' }))).status).toBe(409);
    expect((await POST(req({ name: ' ​ ' }))).status).toBe(400);
    expect((await POST(req({ name: 'ㄱ'.repeat(MAX_CATEGORY_NAME + 1) }))).status).toBe(400);
    expect((await POST(badJson)).status).toBe(400);
  });
});

describe('PUT — 순서', () => {
  it('내 기관 카테고리를 못 읽으면 성공(updated 0)이 아니라 500', async () => {
    state.mine = bad();
    const res = await PUT(req({ order: [C2, C1] }));
    expect(res.status).toBe(500);
    expect(writes()).toHaveLength(0);
  });

  it('내 것만, 겹친 id는 한 번만 차례대로', async () => {
    const res = await PUT(req({ order: [C2, C3, C2, C1] }));
    expect((await res.json()).data).toEqual({ updated: 2 });
    const updates = writes();
    expect(updates.map((c) => [arg(c, 'update'), c.ops.find(([n, a]) => n === 'eq' && (a as unknown[])[0] === 'id')?.[1]])).toEqual([
      [[{ display_order: 0 }], ['id', C2]],
      [[{ display_order: 1 }], ['id', C1]],
    ]);
    expect(updates.every((c) => has(c, 'eq', 'organization_id', 'org1'))).toBe(true);
  });

  it('id 꼴이 아니면 400, 보낸 것 중 내 것이 하나도 없으면 404', async () => {
    expect((await PUT(req({ order: ['x'] }))).status).toBe(400);
    expect((await PUT(req({ order: 'x' }))).status).toBe(400);
    expect((await PUT(badJson)).status).toBe(400);
    expect((await PUT(req({ order: [C3] }))).status).toBe(404);
    expect(writes()).toHaveLength(0);
  });

  it('한 줄이 실패하면 500', async () => {
    state.orderUpdate = bad();
    expect((await PUT(req({ order: [C1, C2] }))).status).toBe(500);
  });
});

describe('PATCH — 이름 바꾸기', () => {
  it('이름을 바꾸고 그 이름을 쓰던 기관의 비서를 옮긴다', async () => {
    const res = await patch({ name: ' 인사·복무 ' });
    expect(res.status).toBe(200);
    expect((await res.json()).data.name).toBe('인사·복무');
    const moved = on('agents')[0];
    expect(arg(moved, 'update')).toEqual([{ category: '인사·복무' }]);
    expect(has(moved, 'eq', 'organization_id', 'org1')).toBe(true);
    expect(has(moved, 'eq', 'category', '인사')).toBe(true);
    expect(state.systemLogs).toHaveLength(0);
  });

  it('비서를 못 옮기면 카테고리 이름을 되돌린다 — 새 이름인 그 행만', async () => {
    state.moved = bad();
    const res = await patch({ name: '인사·복무' });
    expect(res.status).toBe(500);
    expect((await res.json()).error.message).toContain('이름을 바꾸지 않았습니다');
    const revert = on('agent_categories').filter((c) => did(c, 'update'))[1];
    expect(arg(revert, 'update')).toEqual([{ name: '인사' }]);
    expect(has(revert, 'eq', 'id', C1)).toBe(true);
    expect(has(revert, 'eq', 'organization_id', 'org1')).toBe(true);
    expect(has(revert, 'eq', 'name', '인사·복무')).toBe(true);
    expect(state.systemLogs).toHaveLength(0);
  });

  it('되돌리기도 실패하면 운영 기록에 남기고(이름 원문 없음) 원래 이름으로 바꾸라고 안내', async () => {
    state.moved = bad();
    state.reverted = bad();
    const res = await patch({ name: '인사·복무' });
    expect(res.status).toBe(500);
    expect((await res.json()).error.message).toContain('원래대로');
    expect(state.systemLogs).toHaveLength(1);
    expect(state.systemLogs[0]).toMatchObject({ level: 'error', category: 'database', orgId: 'org1', details: { category_id: C1, move_code: 'XX000', revert_code: 'XX000' } });
    expect(JSON.stringify(state.systemLogs[0])).not.toContain('인사·복무');
  });

  it('대상을 못 읽으면 404가 아니라 503, 없으면 404, id 꼴이 아니면 읽지 않고 404', async () => {
    state.category = bad();
    expect((await patch({ name: '바꿈' })).status).toBe(503);
    state.category = ok(null);
    expect((await patch({ name: '바꿈' })).status).toBe(404);
    state.calls = [];
    expect((await patch({ name: '바꿈' }, 'not-a-uuid')).status).toBe(404);
    expect(on('agent_categories')).toHaveLength(0);
    expect(writes()).toHaveLength(0);
  });

  it('같은 이름이면 쓰지 않고, 겹친 이름은 409(비서는 안 옮김), 그 사이 지워졌으면 404', async () => {
    expect((await patch({ name: ' 인사 ' })).status).toBe(200);
    expect(writes()).toHaveLength(0);

    state.renamed = { data: null, error: { code: '23505', message: 'dup' } };
    expect((await patch({ name: '회계' })).status).toBe(409);
    expect(on('agents')).toHaveLength(0);

    state.renamed = ok([]);
    expect((await patch({ name: '바꿈' })).status).toBe(404);
    expect(on('agents')).toHaveLength(0);

    expect((await PATCH(badJson, { params: { id: C1 } })).status).toBe(400);
  });
});

describe('DELETE', () => {
  it('비서를 먼저 미분류로 떼고 카테고리를 지운다', async () => {
    const res = await del();
    expect(res.status).toBe(200);
    const w = writes();
    expect(w.map((c) => c.table)).toEqual(['agents', 'agent_categories']);
    expect(arg(w[0], 'update')).toEqual([{ category: null }]);
    expect(has(w[0], 'eq', 'category', '인사')).toBe(true);
    expect(has(w[1], 'eq', 'organization_id', 'org1')).toBe(true);
  });

  it('대상을 못 읽으면 503, 비서를 못 떼면 지우지 않는다', async () => {
    state.category = bad();
    expect((await del()).status).toBe(503);
    expect(writes()).toHaveLength(0);

    state.category = ok({ id: C1, name: '인사', display_order: 0 });
    state.moved = bad();
    expect((await del()).status).toBe(500);
    expect(writes().some((c) => did(c, 'delete'))).toBe(false);
  });
});

describe('이름 다듬기', () => {
  it('제어 글자·보이지 않는 글자를 빼고 공백을 하나로, 이모지를 잇는 글자는 남긴다', () => {
    expect(cleanCategoryName('인​사﻿')).toEqual({ ok: true, name: '인사' });
    expect(cleanCategoryName('인사\t\n 복무')).toEqual({ ok: true, name: '인사 복무' });
    expect(cleanCategoryName('🧑‍💼 인사')).toEqual({ ok: true, name: '🧑‍💼 인사' });
    expect(cleanCategoryName(12).ok).toBe(false);
    expect(cleanCategoryName('가'.repeat(MAX_CATEGORY_NAME)).ok).toBe(true);
    expect(cleanCategoryName('가'.repeat(MAX_CATEGORY_NAME + 1)).ok).toBe(false);
  });
});

describe('원본 확인', () => {
  const routes = ['src/app/api/admin/agent-categories/route.ts', 'src/app/api/admin/agent-categories/[id]/route.ts'];

  it('두 라우트의 모든 핸들러가 requireAdminOrg를 거치고, 바꾸기는 edit', () => {
    const list = readFileSync(routes[0], 'utf8');
    const one = readFileSync(routes[1], 'utf8');
    expect(list.match(/await requireAdminOrg\('read'\)/g)).toHaveLength(1);
    expect(list.match(/await requireAdminOrg\('edit'\)/g)).toHaveLength(2);
    expect(one.match(/await requireAdminOrg\('edit'\)/g)).toHaveLength(2);
    expect(one).not.toContain("await requireAdminOrg('read')");
  });

  it('오류를 받지 않는 읽기가 없다', () => {
    for (const p of [...routes, 'src/lib/agent-category-admin.ts']) {
      expect(readFileSync(p, 'utf8')).not.toMatch(/const \{ data(: \w+)? \} = await supabaseAdmin/);
    }
  });

  it('화면은 canEdit일 때만 바꾸기 단추를 보이고, 비서 수 null을 0으로 보이지 않는다', () => {
    const ui = readFileSync('src/components/admin/AgentsManager.tsx', 'utf8');
    expect(ui).toContain('setCanEditCategories(result.canEdit === true)');
    expect(ui).toContain("category.agent_count === null ? '비서 수 확인 못 함'");
    expect(ui).toContain('{canEditCategories && (<>');
  });
});
