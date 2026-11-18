import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-18 — 관리자 대시보드·통계 화면의 첫 카드(`/api/stats`)가 **자기 부서 한 곳만** 세었다. 같은 화면 아래 '사용량 추이'·이용통계는
 * 관리 범위(자기 부서 + 하위, 기관 직속 부서 관리자는 기관 전체)라 숫자가 어긋났고, 기관 전체 관리자의 첫 화면이 거의 0이었다.
 * 지운 비서·나만의 비서·탈퇴/사용 중지 계정·지난 판 문서까지 셌고, 토큰은 화면을 열 때마다 모든 사용 기록을 읽어 더했으며,
 * 읽기 실패는 0으로 보였다. 옛 보고서 템플릿 수를 '생성된 보고서'로, 늘 '정상'인 시스템 상태도 보였다.
 */

type Call = { table: string; ops: Array<[string, unknown[]]> };
const state: {
  session: unknown;
  calls: Call[];
  counts: Record<string, { count: number | null; error: unknown }>;
  activity: { data: unknown; error: unknown };
  paged: Array<{ data: unknown; error: unknown }>;
} = { session: null, calls: [], counts: {}, activity: { data: [], error: null }, paged: [] };

const MANAGED = ['d1', 'd2', 'd3'];

vi.mock('@/lib/auth', () => ({
  getServerAuthSession: async () => state.session,
  isAdminSession: (s: { user?: { role?: string } } | null) => s?.user?.role === 'ADMIN',
}));
vi.mock('@/lib/department-scope', () => ({ getManagedDepartmentIds: async () => MANAGED }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const call: Call = { table, ops: [] };
      state.calls.push(call);
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'neq', 'in', 'is', 'gte', 'lte', 'order', 'range', 'limit', 'not']) {
        b[n] = (...args: unknown[]) => { call.ops.push([n, args]); return b; };
      }
      b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
        const limited = call.ops.some(([n]) => n === 'limit');
        const result = limited ? state.activity : state.counts[table] ?? { count: 0, error: null };
        return Promise.resolve(result).then(ok, bad);
      };
      return b;
    },
  },
}));
vi.mock('@/lib/paged-select', () => ({
  pagedRows: async (build: (a: number, b: number, w: boolean) => unknown) => { build(0, 999, true); return state.paged.shift() ?? { data: [], error: null }; },
}));

import { GET } from '@/app/api/stats/route';
import { GET as GET_USAGE } from '@/app/api/stats/usage/route';
import { kstMonthStart } from '@/lib/kst-time';
import { USAGE_ACTION_LABELS } from '@/lib/usage-summary';

const admin = { user: { id: 'u1', role: 'ADMIN', departmentId: 'd1' } };
const ERR = { code: 'XX000', message: 'boom' };
const callOf = (table: string, pick: (c: Call) => boolean = () => true) => state.calls.find((c) => c.table === table && pick(c))!;
const has = (c: Call, name: string, ...args: unknown[]) => c.ops.some(([n, a]) => n === name && JSON.stringify(a) === JSON.stringify(args));

beforeEach(() => {
  state.session = admin;
  state.calls = [];
  state.counts = {
    documents: { count: 12, error: null },
    agents: { count: 7, error: null },
    conversations: { count: 30, error: null },
    messages: { count: 90, error: null },
    users: { count: 5, error: null },
  };
  state.activity = { data: [{ action: 'chat_message', created_at: '2026-11-18T01:00:00Z' }], error: null };
  state.paged = [];
});

describe('GET /api/stats', () => {
  it('관리 범위로 센다 — 자기 부서 하나로 좁히지 않음', async () => {
    state.paged = [{ data: [{ details: { input_tokens: 100, output_tokens: 20 } }], error: null }];
    const body = await (await GET({} as never)).json();
    expect(body).toEqual({
      ok: true,
      data: {
        departmentCount: 3,
        totalDocuments: 12,
        totalAgents: 7,
        totalConversations: 30,
        totalMessages: 90,
        totalUsers: 5,
        monthlyTokens: 120,
        recentActivity: [{ action: 'chat_message', created_at: '2026-11-18T01:00:00Z' }],
      },
    });
    for (const c of state.calls) {
      const column = c.table === 'messages' ? 'conversations.department_id' : 'department_id';
      expect(has(c, 'in', column, MANAGED), c.table).toBe(true);
      expect(c.ops.some(([n, a]) => n === 'eq' && a[0] === 'department_id'), c.table).toBe(false);
    }
    expect(state.calls.map((c) => c.table).sort()).toEqual(['agents', 'conversations', 'documents', 'messages', 'usage_logs', 'usage_logs', 'users']);
  });

  it('지운 비서·나만의 비서, 탈퇴·사용 중지 계정, 지난 판 문서는 세지 않음', async () => {
    await GET({} as never);
    const agents = callOf('agents');
    expect(has(agents, 'is', 'deleted_at', null)).toBe(true);
    expect(has(agents, 'neq', 'tier', 'personal')).toBe(true);
    const users = callOf('users');
    expect(has(users, 'is', 'deleted_at', null)).toBe(true);
    expect(has(users, 'eq', 'is_active', true)).toBe(true);
    expect(has(callOf('documents'), 'is', 'retired_at', null)).toBe(true);
  });

  it('토큰은 이번 달(한국 시간)부터 — 숫자가 아닌 값은 0', async () => {
    state.paged = [{
      data: [
        { details: { input_tokens: 1000, output_tokens: 500 } },
        { details: { input_tokens: '900', output_tokens: 5 } },
        { details: { input_tokens: 7 } },
        { details: null },
      ],
      error: null,
    }];
    const before = kstMonthStart(new Date(), 0).toISOString();
    const body = await (await GET({} as never)).json();
    expect(body.data.monthlyTokens).toBe(1512);
    const tokens = callOf('usage_logs', (c) => !c.ops.some(([n]) => n === 'limit'));
    expect(has(tokens, 'gte', 'created_at', before)).toBe(true);
  });

  it.each(['documents', 'agents', 'conversations', 'messages', 'users'])('%s 수를 못 읽으면 503 — 0으로 보이지 않음', async (table) => {
    state.counts[table] = { count: null, error: ERR };
    const res = await GET({} as never);
    expect(res.status).toBe(503);
    expect((await res.json()).ok).toBe(false);
  });

  it('오류 없이 수가 비어 와도 503', async () => {
    state.counts.users = { count: null, error: null };
    expect((await GET({} as never)).status).toBe(503);
  });

  it('토큰 기록·최근 활동을 못 읽어도 503', async () => {
    state.paged = [{ data: null, error: ERR }];
    expect((await GET({} as never)).status).toBe(503);
    state.paged = [];
    state.activity = { data: null, error: ERR };
    expect((await GET({} as never)).status).toBe(503);
  });

  it('로그인 없으면 401, 직원은 403 — 아무것도 읽지 않음', async () => {
    state.session = null;
    expect((await GET({} as never)).status).toBe(401);
    state.session = { user: { id: 'u2', role: 'USER', departmentId: 'd1' } };
    expect((await GET({} as never)).status).toBe(403);
    expect(state.calls).toEqual([]);
  });
});

describe('GET /api/stats/usage', () => {
  const req = { url: 'http://x/api/stats/usage?start=2026-11-10T00:00:00Z&end=2026-11-12T00:00:00Z' } as never;
  it.each([0, 1, 2])('읽기 %i번이 실패하면 503 — 빈 차트로 그리지 않음', async (bad) => {
    state.paged = [0, 1, 2].map((i) => (i === bad ? { data: null, error: ERR } : { data: [], error: null }));
    const res = await GET_USAGE(req);
    expect(res.status).toBe(503);
  });
  it('숫자가 아닌 토큰은 0 — 그날 합계가 NaN이 되지 않음', async () => {
    state.paged = [
      { data: [], error: null },
      { data: [], error: null },
      { data: [
        { created_at: '2026-11-11T03:00:00Z', action: 'chat_message', details: { input_tokens: 10, output_tokens: 5 } },
        { created_at: '2026-11-11T04:00:00Z', action: 'chat_message', details: { input_tokens: 'abc', output_tokens: 1 } },
      ], error: null },
    ];
    const body = await (await GET_USAGE(req)).json();
    const day = body.data.find((d: { date: string }) => d.date === '2026-11-11');
    expect(day.tokens).toBe(16);
  });
});

describe('원본', () => {
  const route = readFileSync('src/app/api/stats/route.ts', 'utf8');
  const dash = readFileSync('src/components/admin/StatsDashboard.tsx', 'utf8');
  const quick = readFileSync('src/components/admin/QuickStats.tsx', 'utf8');

  it('옛 보고서 템플릿 수·모든 기간 토큰이 돌아오지 않음', () => {
    expect(route).not.toContain('report_templates');
    expect(route).not.toContain('totalTokens');
    expect(route).toContain('getManagedDepartmentIds(departmentId)');
  });
  it('화면 — 새 칸을 읽고, 꾸민 카드(보고서·늘 정상인 상태)가 없음', () => {
    expect(dash).toContain('stats?.monthlyTokens');
    expect(dash).toContain('stats?.totalUsers');
    expect(quick).toContain('stats?.monthlyTokens');
    for (const src of [dash, quick]) {
      expect(src).not.toContain('totalTokens');
      expect(src).not.toContain('totalReports');
      expect(src).not.toContain('recentReports');
    }
    expect(dash).not.toContain('시스템 상태');
    expect(quick).toContain('setFailed(true)');
  });
  it('최근 활동 이름표가 이용통계의 활동을 모두 덮음 — 코드가 그대로 보이지 않게', () => {
    for (const [action, label] of Object.entries(USAGE_ACTION_LABELS)) {
      expect(dash, action).toContain(`${action}: '${label}'`);
    }
  });
});
