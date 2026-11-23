import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-19 — 슈퍼관리자 기관 상세 탭·업무 화면 설정·API 키 화면이 읽기 실패를 '없음'으로 보이던 것.
 * - 기관 사용자·초대 링크: 부서를 못 읽으면 빈 목록('사용자가 없습니다')
 * - 기관·시스템 API 키: 키를 못 읽으면 '키 없음(시스템 키 사용)'·'(미설정)', 풀지 못하는 암호문이면 500
 * - 업무 화면 설정: 기관을 못 읽으면 404, 저장소 오류는 처리하지 않은 예외
 * - 기관 API 키 저장: 깨진 요청·글이 아닌 키에서 500
 */

type Chain = { table: string; ops: Array<[string, unknown[]]> };
const state = {
  chains: [] as Chain[],
  respond: (_c: Chain): unknown => ({ data: [], error: null }),
  store: { get: async () => ({ homeEnabled: false, newTasksEnabled: false }) as unknown, put: async () => ({ homeEnabled: true, newTasksEnabled: true }) as unknown },
};
const has = (c: Chain, op: string) => c.ops.some(([k]) => k === op);

vi.mock('@/lib/super-auth', () => ({ getSuperAdminFromRequest: () => ({ sub: 'sa' }) }));
vi.mock('@/lib/audit-write', () => ({ writeAuditRow: vi.fn(async () => true) }));
vi.mock('@/lib/crypto', () => ({
  encryptApiKey: (v: string) => `enc:${v}`,
  decryptApiKey: (v: string) => { if (v === 'broken') throw new Error('bad'); return v.replace(/^enc:/, ''); },
  maskKey: (v: string) => `${v.slice(0, 3)}***`,
  maskApiKey: (v: string) => `${v.slice(0, 3)}***`,
}));
vi.mock('@/lib/work/store/supabase', () => ({
  createSupabaseWorkStore: () => ({ getOrgSettings: () => state.store.get(), upsertOrgSettings: () => state.store.put() }),
}));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain: Chain = { table, ops: [] };
      state.chains.push(chain);
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'is', 'in', 'or', 'order', 'range', 'limit', 'gte', 'update', 'insert']) b[n] = (...a: unknown[]) => { chain.ops.push([n, a]); return b; };
      b.maybeSingle = async () => state.respond(chain);
      b.single = async () => state.respond(chain);
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(state.respond(chain)).then(res, rej);
      return b;
    },
  },
}));

import { GET as orgUsers } from '@/app/api/super/organizations/[id]/users/route';
import { GET as orgInvites } from '@/app/api/super/organizations/[id]/invitations/route';
import { GET as orgKeys, PATCH as orgKeysPatch } from '@/app/api/super/organizations/[id]/api-keys/route';
import { GET as systemKeys } from '@/app/api/super/api-keys/system/route';
import { PATCH as workPatch } from '@/app/api/super/work-settings/route';

const ORG = '11111111-1111-1111-1111-111111111111';
const get = (url = 'http://x/') => new Request(url) as never;
const patch = (body: unknown) => new Request('http://x/', {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
}) as never;
const fail = { data: null, error: { code: 'XX000' }, count: null };

beforeEach(() => {
  state.chains = [];
  state.respond = () => ({ data: [], error: null, count: 0 });
  state.store = { get: async () => ({ homeEnabled: false, newTasksEnabled: false }), put: async () => ({ homeEnabled: true, newTasksEnabled: true }) };
});

describe('기관 사용자·초대 링크', () => {
  it('부서를 못 읽으면 503 — 빈 목록이 아님', async () => {
    state.respond = (c) => (c.table === 'departments' ? fail : { data: [], error: null });
    const u = await orgUsers(get(), { params: { id: ORG } });
    expect(u.status).toBe(503);
    expect(state.chains.some((c) => c.table === 'users')).toBe(false);
    const i = await orgInvites(get(), { params: { id: ORG } });
    expect(i.status).toBe(503);
    expect(state.chains.some((c) => c.table === 'invitations')).toBe(false);
  });

  it('사용자 탭의 부서는 쪽마다 읽는다', async () => {
    state.respond = (c) => (c.table === 'departments' ? { data: [{ id: 'd1', name: '총무과' }], error: null, count: 1 } : { data: [{ id: 'u1', department_id: 'd1' }], error: null, count: 1 });
    const res = await orgUsers(get(), { params: { id: ORG } });
    expect(res.status).toBe(200);
    expect(has(state.chains.find((c) => c.table === 'departments')!, 'range')).toBe(true);
    expect((await res.json()).data[0].department_name).toBe('총무과');
  });

  it('부서가 정말 없으면 빈 목록 200', async () => {
    expect((await orgUsers(get(), { params: { id: ORG } })).status).toBe(200);
    expect((await orgInvites(get(), { params: { id: ORG } })).status).toBe(200);
  });
});

describe('API 키 상태', () => {
  it('기관 키를 못 읽으면 503 — 시스템 키 사용으로 보이지 않음', async () => {
    state.respond = () => fail;
    expect((await orgKeys(get(), { params: { id: ORG } })).status).toBe(503);
  });

  it('풀지 못하는 암호문이어도 화면은 열린다', async () => {
    state.respond = () => ({ data: [{ id: 'k1', provider: 'anthropic', key_prefix: 'sk-a', key_value: 'broken', is_active: true }], error: null });
    const res = await orgKeys(get(), { params: { id: ORG } });
    expect(res.status).toBe(200);
    expect((await res.json()).data.anthropic.masked).toBe('(풀지 못함)');
  });

  it('시스템 키를 못 읽으면 503', async () => {
    state.respond = (c) => (c.table === 'api_keys' ? fail : { data: [], error: null, count: 0 });
    expect((await systemKeys(get())).status).toBe(503);
  });

  it('기관 키 저장 — 깨진 요청·글이 아닌 키는 400(500이 아님), 키는 다듬어 저장', async () => {
    expect((await orgKeysPatch(patch('{깨짐'), { params: { id: ORG } })).status).toBe(400);
    expect((await orgKeysPatch(patch({ provider: 'anthropic', keyValue: 12345 }), { params: { id: ORG } })).status).toBe(400);
    expect((await orgKeysPatch(patch({ provider: 'anthropic', keyValue: '   ' }), { params: { id: ORG } })).status).toBe(400);
    expect(state.chains).toHaveLength(0);
    state.respond = () => ({ data: null, error: null });
    expect((await orgKeysPatch(patch({ provider: 'anthropic', keyValue: '  sk-ant-xyz  ' }), { params: { id: ORG } })).status).toBe(200);
    const ins = state.chains.find((c) => has(c, 'insert'))!;
    expect(ins.ops.find(([k]) => k === 'insert')![1][0]).toMatchObject({ key_value: 'enc:sk-ant-xyz', key_prefix: 'sk-ant-x' });
  });
});

describe('업무 화면 설정 PATCH', () => {
  const body = { organizationId: ORG, homeEnabled: true, newTasksEnabled: true };
  it('기관을 못 읽으면 503, 없으면 404', async () => {
    state.respond = () => fail;
    expect((await workPatch(patch(body))).status).toBe(503);
    state.respond = () => ({ data: null, error: null });
    expect((await workPatch(patch(body))).status).toBe(404);
  });
  it('저장소 오류는 한국어 500', async () => {
    state.respond = () => ({ data: { id: ORG }, error: null });
    state.store.put = async () => { throw Object.assign(new Error('x'), { code: 'XX000' }); };
    const res = await workPatch(patch(body));
    expect(res.status).toBe(500);
    expect((await res.json()).error.message).toContain('저장하지 못했습니다');
  });
});

describe('원본 확인 — 화면', () => {
  const src = readFileSync('src/app/super/organizations/[id]/page.tsx', 'utf8');
  it('사용자 탭은 실패를 따로 보인다', () => {
    expect(src).toContain('사용자 목록을 불러오지 못했습니다');
  });
  it('API 키 탭의 끄기는 응답을 본다', () => {
    const h = src.slice(src.indexOf('const handleToggleSystem'), src.indexOf('const handleSave'));
    expect(h).toContain('res?.ok && d?.ok');
  });
  it('초대 링크 목록 실패를 알린다', () => {
    // 0267부터 알림이 아니라 목록 자리에 남는다
    expect(src).toContain("invitationsUnread ? emptyListText(true, '', '초대 링크 목록을')");
  });
  it('시스템 키 화면도 실패를 알린다', () => {
    expect(readFileSync('src/app/super/api-keys/page.tsx', 'utf8')).toContain('API 키 상태를 불러오지 못했습니다');
  });
});
