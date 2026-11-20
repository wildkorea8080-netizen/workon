import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-19 — 즐겨찾기를 못 읽으면 '없음'이 아니다.
 * 예전 비서 목록(`GET /api/agents`)은 즐겨찾기 읽기 실패를 빈 목록으로 보아 즐겨찾기 탭이 비고 별 표시가 모두 꺼졌고,
 * 사용자 행을 못 읽으면 '부서 정보를 찾을 수 없습니다'(403). 옛 즐겨찾기 길(`/api/agents/favorite`)은 '사용자 정보를 찾을 수 없습니다'(404).
 */

const state = { favError: null as unknown, favs: ['a1'] as string[] | null, userError: null as unknown, session: null as unknown };

vi.mock('@/lib/auth', () => ({
  getServerAuthSession: vi.fn(async () => state.session),
}));
vi.mock('@/lib/department-scope', () => ({
  getAccessScope: vi.fn(async () => ({ organizationId: 'o1', departmentIds: ['d1'] })),
  visibilityFilter: () => 'visibility.eq.organization',
}));
vi.mock('@/lib/actor-scope', () => ({ getActorScope: vi.fn(async () => ({ userId: 'u1', organizationId: 'o1', departmentId: 'd1', visibleDepartmentIds: ['d1'], managedDepartmentIds: [], isAdmin: false })) }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'or', 'in', 'is', 'order', 'neq', 'not']) b[n] = () => b;
      const userRow = () => ({ data: state.userError || state.favError ? null : { department_id: 'd1', favorite_agent_ids: state.favs }, error: state.userError ?? state.favError });
      b.maybeSingle = async () => (table === 'users' ? userRow() : { data: null, error: null });
      b.single = async () => (table === 'users' ? userRow() : { data: null, error: null });
      b.update = () => ({ eq: async () => ({ error: null }) });
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res);
      return b;
    },
  },
}));

const sessionWithDept = { user: { id: 'u1', role: 'USER', departmentId: 'd1' } };
state.session = sessionWithDept;

import { GET } from '@/app/api/agents/route';
import { POST as favPOST, GET as favGET } from '@/app/api/agents/favorite/route';

const get = (q = '') => GET(new Request(`http://x/api/agents${q}`) as never);

beforeEach(() => {
  state.favError = null; state.userError = null; state.favs = ['a1'];
  state.session = sessionWithDept;
});

describe('GET /api/agents', () => {
  it('즐겨찾기를 읽으면 meta에 싣는다', async () => {
    expect((await (await get()).json()).meta).toEqual({ favoriteIds: ['a1'] });
  });
  it('못 읽으면 목록은 주되 meta에 싣지 않음(화면은 앞 별 표시 유지), 즐겨찾기 탭은 503', async () => {
    state.favError = { code: 'XX000' };
    const body = await (await get()).json();
    expect(body.ok).toBe(true);
    expect(body.meta).toEqual({});
    expect((await get('?favorites=true')).status).toBe(503);
  });
  it('부서 없는 세션에서 사용자 행을 못 읽으면 403이 아니라 503', async () => {
    state.session = { user: { id: 'u1', role: 'USER' } };
    state.userError = { code: 'XX000' };
    expect((await get()).status).toBe(503);
  });
});

describe('/api/agents/favorite', () => {
  it('못 읽으면 404가 아니라 503 — 쓰지 않음', async () => {
    state.favError = { code: 'XX000' };
    expect((await favGET(new Request('http://x/') as never)).status).toBe(503);
    const res = await favPOST(new Request('http://x/', { method: 'POST', body: JSON.stringify({ agentId: '00000000-0000-4000-8000-0000000000a1' }) }) as never);
    expect(res.status).toBe(503);
  });
});
