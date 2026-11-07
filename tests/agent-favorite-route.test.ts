import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 옛 비서 즐겨찾기 라우트(2026-11-06) — 예전에는 POST가 아무 id나 받아 두고 GET이 같은 부서 비서를 칸 전부와 함께 돌려줘
 * 동료의 나만의 비서 설정(지시문)을 읽을 수 있었다. 이제 쓸 수 있는 비서만(canUseAgent)
 */
const ME = 'u-me';
const OTHER = 'u-other';
const DEPT = 'd-1';
const ORG = 'o-1';

const state: {
  favorites: string[];
  agents: Array<Record<string, unknown>>;
  updated: string[] | null;
} = { favorites: [], agents: [], updated: null };

function agent(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    tier: 'official',
    department_id: DEPT,
    organization_id: ORG,
    visibility: 'organization',
    owner_id: null,
    created_by: OTHER,
    is_active: true,
    is_published: true,
    deleted_at: null,
    approval_status: null,
    version: 1,
    approval_version: null,
    system_prompt: `secret of ${id}`,
    ...over,
  };
}

vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => ({ user: { id: ME, departmentId: DEPT } }) }));
vi.mock('@/lib/actor-scope', () => ({
  getActorScope: async () => ({
    userId: ME,
    isAdmin: false,
    departmentId: DEPT,
    organizationId: ORG,
    visibleDepartmentIds: [DEPT],
    managedDepartmentIds: [],
  }),
}));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === 'users') {
        return {
          select: () => ({ eq: () => ({ single: async () => ({ data: { favorite_agent_ids: state.favorites }, error: null }) }) }),
          update: (patch: { favorite_agent_ids: string[] }) => ({
            eq: async () => {
              state.updated = patch.favorite_agent_ids;
              return { error: null };
            },
          }),
        };
      }
      return {
        select: () => ({
          in: async (_c: string, ids: string[]) => ({ data: state.agents.filter((a) => ids.includes(String(a.id))), error: null }),
          eq: (_c: string, id: string) => ({ maybeSingle: async () => ({ data: state.agents.find((a) => a.id === id) ?? null, error: null }) }),
        }),
      };
    },
  },
}));

import { GET, POST } from '@/app/api/agents/favorite/route';

const post = (agentId: string) =>
  POST(new Request('http://x/api/agents/favorite', { method: 'POST', body: JSON.stringify({ agentId }) }) as never);

beforeEach(() => {
  state.favorites = [];
  state.agents = [];
  state.updated = null;
});

describe('비서 즐겨찾기 — 쓸 수 있는 비서만', () => {
  it('GET은 동료의 나만의 비서·지운 비서·다른 기관 비서를 돌려주지 않는다(같은 부서여도)', async () => {
    state.agents = [
      agent('a-official'),
      agent('a-colleague', { tier: 'personal', owner_id: OTHER, visibility: 'department' }),
      agent('a-mine', { tier: 'personal', owner_id: ME, visibility: 'department' }),
      agent('a-deleted', { deleted_at: '2026-11-01T00:00:00Z' }),
      agent('a-other-org', { organization_id: 'o-2', department_id: 'd-9' }),
      agent('a-other-dept-org-wide', { department_id: 'd-2' }),
    ];
    state.favorites = state.agents.map((a) => String(a.id));
    const body = await (await GET(new Request('http://x') as never)).json();
    const ids = body.data.map((a: { id: string }) => a.id).sort();
    expect(ids).toEqual(['a-mine', 'a-official', 'a-other-dept-org-wide']);
    expect(JSON.stringify(body)).not.toContain('secret of a-colleague');
  });

  it('POST 더하기는 쓸 수 없는 비서를 403으로 거절하고 저장하지 않는다', async () => {
    state.agents = [agent('a-colleague', { tier: 'personal', owner_id: OTHER, visibility: 'department' })];
    const res = await post('a-colleague');
    expect(res.status).toBe(403);
    expect(state.updated).toBeNull();
    const missing = await post('a-nope');
    expect(missing.status).toBe(403);
  });

  it('POST 더하기는 쓸 수 있는 비서면 저장, 빼기는 못 쓰게 된 비서도 된다', async () => {
    state.agents = [agent('a-official'), agent('a-gone', { deleted_at: '2026-11-01T00:00:00Z' })];
    const added = await (await post('a-official')).json();
    expect(added.data).toEqual({ isFavorite: true, favoriteIds: ['a-official'] });

    state.favorites = ['a-gone'];
    const removed = await (await post('a-gone')).json();
    expect(removed.data).toEqual({ isFavorite: false, favoriteIds: [] });
  });

  it('200개를 넘겨 더하지 않는다', async () => {
    state.agents = [agent('a-official')];
    state.favorites = Array.from({ length: 200 }, (_, i) => `x-${i}`);
    const res = await post('a-official');
    expect(res.status).toBe(400);
    expect(state.updated).toBeNull();
  });
});
