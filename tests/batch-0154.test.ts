import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-18 — 내 사용현황(`/my/stats`)의 토큰이 대화 글자 수 ÷ 4 어림이었다. 한글은 글자당 토큰이 많고
 * 시스템 프롬프트·참고 문서·도구 결과·첨부는 메시지 글에 없어 실제의 몇 분의 일로 보였다(개인 월 한도 알림 메일이 이 화면으로 보냄).
 * 이제 기록한 실제 사용량(`usage_logs`)으로 세고, 읽기 실패는 0건·0토큰 대신 503.
 */

const state: { paged: Array<{ data: unknown; error: unknown }>; tables: string[] } = { paged: [], tables: [] };

vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => ({ user: { id: 'u1' } }) }));
vi.mock('@/lib/usage-limit', () => ({ myMonthlyBudget: async () => null }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (t: string) => {
      state.tables.push(t);
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'gte', 'lte', 'in', 'order', 'range']) b[n] = () => b;
      return b;
    },
  },
}));
vi.mock('@/lib/paged-select', () => ({
  pagedRows: async (build: (a: number, b: number, w: boolean) => unknown) => { build(0, 999, true); return state.paged.shift() ?? { data: [], error: null }; },
}));

import { sumMyTokens } from '@/lib/my-usage-tokens';
import { GET } from '@/app/api/my/stats/route';

const req = (q = 'period=month') => ({ url: `http://x/api/my/stats?${q}` }) as never;
const now = new Date();
const iso = now.toISOString();
const ERR = { code: 'XX000', message: 'boom' };

beforeEach(() => { state.paged = []; state.tables = []; });

describe('sumMyTokens', () => {
  const t = Date.parse('2026-11-18T03:00:00Z');
  const range = { monthStartMs: Date.parse('2026-10-31T15:00:00Z'), periodStartMs: Date.parse('2026-11-11T15:00:00Z'), periodEndMs: t };
  it('이번 달은 달 시작부터, 비서별은 고른 기간 안만', () => {
    const r = sumMyTokens([
      { details: { input_tokens: 100, output_tokens: 50, agent_id: 'a1' }, created_at: '2026-11-17T00:00:00Z' },
      { details: { input_tokens: 10, output_tokens: 5, agent_id: 'a1' }, created_at: '2026-11-02T00:00:00Z' }, // 이번 달이지만 기간 밖
      { details: { input_tokens: 7, output_tokens: 3 }, created_at: '2026-11-17T01:00:00Z' }, // 비서 없는 기록(업무 작업 등)
      { details: { input_tokens: 999, output_tokens: 1, agent_id: 'a2' }, created_at: '2026-10-30T00:00:00Z' }, // 지난달
    ], range);
    expect(r.monthly).toBe(175);
    expect([...r.byAgent]).toEqual([['a1', 150]]);
  });
  it('숫자가 아닌 토큰·토큰 없는 기록·시각을 못 읽는 기록은 세지 않음', () => {
    const r = sumMyTokens([
      { details: { input_tokens: '100', output_tokens: 5, agent_id: 'a1' }, created_at: '2026-11-17T00:00:00Z' },
      { details: { agent_id: 'a1' }, created_at: '2026-11-17T00:00:00Z' },
      { details: null, created_at: '2026-11-17T00:00:00Z' },
      { details: { input_tokens: 9, output_tokens: 1, agent_id: 'a1' }, created_at: 'x' },
    ], range);
    expect(r.monthly).toBe(5);
    expect(r.byAgent.get('a1')).toBe(5);
  });
});

describe('GET /api/my/stats', () => {
  it('토큰은 사용 기록에서 — 메시지 글을 읽지 않음', async () => {
    state.paged = [
      { data: [{ id: 'c1', agent_id: 'a1', title: '대화', created_at: iso, agents: { name: '비서', icon: '📄' } }], error: null },
      { data: [{ details: { input_tokens: 4000, output_tokens: 1000, agent_id: 'a1' }, created_at: iso }], error: null },
      { data: [{ id: 'c1' }], error: null },
      { data: [{ created_at: iso }], error: null },
    ];
    const body = await (await GET(req())).json();
    expect(body.ok).toBe(true);
    expect(body.data.summary).toMatchObject({ monthlyConvCount: 1, monthlyTokens: 5000, streakDays: 1 });
    expect(body.data.agentStats[0]).toMatchObject({ agentId: 'a1', convCount: 1, tokens: 5000 });
    expect(state.tables).toEqual(['conversations', 'usage_logs', 'conversations', 'conversations']);
  });
  it.each([0, 1, 2, 3])('읽기 %i번이 실패하면 503 — 0으로 보이지 않음', async (bad) => {
    state.paged = [0, 1, 2, 3].map((i) => (i === bad ? { data: null, error: ERR } : { data: [], error: null }));
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect((await res.json()).ok).toBe(false);
  });
});

describe('원본', () => {
  const route = readFileSync('src/app/api/my/stats/route.ts', 'utf8');
  it('글자 수 ÷ 4 어림이 돌아오지 않음', () => {
    expect(route).not.toMatch(/length \/ 4/);
    expect(route).not.toContain(".from('messages')");
    expect(route).toContain(".eq('user_id', userId)");
  });
  it('화면은 새 칸을 읽음', () => {
    const ui = readFileSync('src/app/my/stats/page.tsx', 'utf8');
    expect(ui).toContain('data?.summary.monthlyTokens');
    expect(ui).toContain('formatTokens(s.tokens)');
    expect(ui).not.toContain('tokenEstimate');
  });
});
