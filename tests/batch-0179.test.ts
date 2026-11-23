import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-19 — 슈퍼관리자 계정의 사용 중지·권한 바꾸기.
 * ① 슈퍼관리자 PATCH: `isActive` 꼴을 보지 않았고, 대상이 없으면 500, 두 슈퍼관리자가 거의 동시에 서로를 끄면
 *    사용 중인 슈퍼관리자가 0명이 될 수 있었다(첫 설정은 슈퍼관리자가 있으면 막아 아무도 못 들어온다).
 * ② 직원 PATCH(`/api/super/accounts/users/[id]`)가 슈퍼관리자 계정도 받아, 슈퍼관리자 탭의 '본인 아님·마지막 1명'
 *    검사를 건너뛰고 본인·마지막 슈퍼관리자를 끌 수 있었다. 전 값을 못 읽어도 바꿨다.
 */

type Chain = { table: string; ops: Array<[string, unknown[]]> };
const state = {
  admin: { sub: 'me' } as unknown,
  chains: [] as Chain[],
  respond: (_c: Chain): unknown => ({ data: null, error: null }),
};
const has = (c: Chain, op: string) => c.ops.some(([k]) => k === op);
const arg = (c: Chain, op: string) => c.ops.find(([k]) => k === op)?.[1];

vi.mock('@/lib/super-auth', () => ({ getSuperAdminFromRequest: () => state.admin }));
vi.mock('@/lib/audit-write', () => ({ writeAuditRow: vi.fn(async () => true) }));
vi.mock('@/lib/user-withdrawal', () => ({ withdrawUser: async () => ({ ok: true, before: {} }) }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain: Chain = { table, ops: [] };
      state.chains.push(chain);
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'is', 'update', 'neq', 'limit']) b[n] = (...a: unknown[]) => { chain.ops.push([n, a]); return b; };
      b.maybeSingle = async () => state.respond(chain);
      b.single = async () => state.respond(chain);
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(state.respond(chain)).then(res, rej);
      return b;
    },
  },
}));

import { writeAuditRow } from '@/lib/audit-write';
import { PATCH as patchSuper } from '@/app/api/super/accounts/super-admins/[id]/route';
import { PATCH as patchUser } from '@/app/api/super/accounts/users/[id]/route';

const req = (body: unknown) => new Request('http://x', {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
}) as never;
const updates = () => state.chains.filter((c) => has(c, 'update'));

beforeEach(() => {
  state.admin = { sub: 'me' };
  state.chains = [];
  state.respond = () => ({ data: null, error: null });
  vi.mocked(writeAuditRow).mockClear();
});

describe('슈퍼관리자 사용 중지 PATCH', () => {
  /** count 응답: 읽은 순서대로 */
  function world(opts: { target?: { id: string; is_active: boolean } | null; beforeError?: boolean; counts?: Array<number | null>; updateRow?: unknown }) {
    const counts = [...(opts.counts ?? [3, 2])];
    state.respond = (c) => {
      const sel = arg(c, 'select') as unknown[] | undefined;
      if (has(c, 'update')) {
        const patch = arg(c, 'update')![0] as { is_active: boolean };
        return { data: opts.updateRow === undefined ? { id: 't1', email: 't@x.kr', is_active: patch.is_active } : opts.updateRow, error: null };
      }
      if (sel && (sel[1] as { head?: boolean } | undefined)?.head) {
        const n = counts.shift();
        return n === null || n === undefined ? { count: null, error: { code: 'XX000' } } : { count: n, error: null };
      }
      if (opts.beforeError) return { data: null, error: { code: 'XX000' } };
      return { data: opts.target === undefined ? { id: 't1', is_active: true } : opts.target, error: null };
    };
  }

  it('isActive가 참·거짓이 아니면 400 — DB를 부르지 않음', async () => {
    for (const b of [{ isActive: 'false' }, {}, { isActive: null }, '{깨짐']) {
      state.chains = [];
      expect((await patchSuper(req(b), { params: { id: 't1' } })).status).toBe(400);
      expect(state.chains).toHaveLength(0);
    }
  });

  it('본인은 끄지 못함', async () => {
    world({});
    expect((await patchSuper(req({ isActive: false }), { params: { id: 'me' } })).status).toBe(400);
    expect(updates()).toHaveLength(0);
  });

  it('대상이 없거나 슈퍼관리자가 아니면 404, 못 읽으면 503 — 바꾸지 않음', async () => {
    world({ target: null });
    expect((await patchSuper(req({ isActive: false }), { params: { id: 't1' } })).status).toBe(404);
    world({ beforeError: true });
    expect((await patchSuper(req({ isActive: false }), { params: { id: 't1' } })).status).toBe(503);
    expect(updates()).toHaveLength(0);
  });

  it('사용 중인 수를 못 세면 503, 1명이면 400 — 바꾸지 않음', async () => {
    world({ counts: [null] });
    expect((await patchSuper(req({ isActive: false }), { params: { id: 't1' } })).status).toBe(503);
    world({ counts: [1] });
    expect((await patchSuper(req({ isActive: false }), { params: { id: 't1' } })).status).toBe(400);
    expect(updates()).toHaveLength(0);
  });

  it('끈 뒤 다시 세어 0명이면 되돌리고 409', async () => {
    world({ counts: [2, 0] });
    const res = await patchSuper(req({ isActive: false }), { params: { id: 't1' } });
    expect(res.status).toBe(409);
    const ups = updates().map((c) => arg(c, 'update')![0]);
    expect(ups).toEqual([{ is_active: false }, { is_active: true }]);
    expect(writeAuditRow).not.toHaveBeenCalled();
  });

  it('정상 사용 중지 — 한 번만 바꾸고 전·후 값을 기록', async () => {
    world({ counts: [2, 1] });
    const res = await patchSuper(req({ isActive: false }), { params: { id: 't1' } });
    expect(res.status).toBe(200);
    expect(updates()).toHaveLength(1);
    expect(updates()[0].ops).toContainEqual(['eq', ['is_super_admin', true]]);
    expect(vi.mocked(writeAuditRow).mock.calls[0][1]).toMatchObject({ before_data: { is_active: true }, after_data: { is_active: false } });
  });

  it('이미 꺼진 계정 다시 사용은 수를 세지 않고, 같은 값이면 기록하지 않음', async () => {
    world({ target: { id: 't1', is_active: false }, counts: [] });
    expect((await patchSuper(req({ isActive: true }), { params: { id: 't1' } })).status).toBe(200);
    expect(state.chains.some((c) => (arg(c, 'select') as unknown[] | undefined)?.[1])).toBe(false);
    expect(writeAuditRow).toHaveBeenCalledTimes(1);
    vi.mocked(writeAuditRow).mockClear();
    world({ target: { id: 't1', is_active: true } });
    expect((await patchSuper(req({ isActive: true }), { params: { id: 't1' } })).status).toBe(200);
    expect(writeAuditRow).not.toHaveBeenCalled();
  });
});

describe('직원 계정 PATCH는 슈퍼관리자를 받지 않는다', () => {
  function world(before: unknown, beforeError = false) {
    state.respond = (c) => {
      if (has(c, 'update')) return { data: { id: 'u1', email: 'u@x.kr', full_name: '가', role: 'USER' }, error: null };
      return beforeError ? { data: null, error: { code: 'XX000' } } : { data: before, error: null };
    };
  }

  it('슈퍼관리자 계정이면 400 — 바꾸지 않음', async () => {
    world({ is_active: true, role: 'ADMIN', is_super_admin: true });
    expect((await patchUser(req({ isActive: false }), { params: { id: 'me' } })).status).toBe(400);
    expect(updates()).toHaveLength(0);
  });

  it('전 값을 못 읽으면 503, 없으면 404', async () => {
    world(null, true);
    expect((await patchUser(req({ isActive: false }), { params: { id: 'u1' } })).status).toBe(503);
    world(null);
    expect((await patchUser(req({ isActive: false }), { params: { id: 'u1' } })).status).toBe(404);
    expect(updates()).toHaveLength(0);
  });

  it('isActive 꼴·깨진 요청은 400', async () => {
    world({ is_active: true, role: 'USER', is_super_admin: false });
    expect((await patchUser(req({ isActive: 'no' }), { params: { id: 'u1' } })).status).toBe(400);
    expect((await patchUser(req('{깨짐'), { params: { id: 'u1' } })).status).toBe(400);
    expect(state.chains).toHaveLength(0);
  });

  it('직원 계정은 바꾸고 바꾸기 조건에 is_super_admin=false', async () => {
    world({ is_active: true, role: 'USER', is_super_admin: false });
    expect((await patchUser(req({ role: 'ADMIN' }), { params: { id: 'u1' } })).status).toBe(200);
    expect(updates()[0].ops).toContainEqual(['eq', ['is_super_admin', false]]);
    expect(vi.mocked(writeAuditRow).mock.calls[0][1]).toMatchObject({ before_data: { role: 'USER' }, after_data: { role: 'ADMIN' } });
  });
});

describe('원본 확인', () => {
  it('계정 화면은 응답을 보고 실패 문구를 보인다', () => {
    const src = readFileSync('src/app/super/accounts/page.tsx', 'utf8');
    const patch = src.slice(src.indexOf('const handlePatch'), src.indexOf('};', src.indexOf('const handlePatch')));
    const deact = src.slice(src.indexOf('const handleDeactivate'), src.indexOf('};', src.indexOf('const handleDeactivate')));
    for (const h of [patch, deact]) {
      expect(h).toContain('const r = await requestJson('); // 0264부터 — 2xx이고 몸이 ok일 때만 ok
      expect(h).toContain("'바꾸지 못했습니다.'");
    }
  });
});
