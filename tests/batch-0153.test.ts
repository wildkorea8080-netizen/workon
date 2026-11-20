import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-18 — 슈퍼관리자 사용량 화면.
 *  ① 기관별 '한도 사용률'이 고른 기간의 토큰 ÷ 월 한도였다 — '오늘'·'이번 주'는 낮게, 두 달에 걸친 직접 고른 기간은 높게 보였다.
 *     이제 한도 판정과 같은 이번 달 토큰(`loadChatTokensByOrg` — 한국 시간 1일부터 chat_message)으로.
 *  ② 기관 목록을 못 읽으면 모든 기관이 '알 수 없음'·'한도 없음'으로 보였다 → 500(안내).
 *  ③ 실시간 카드는 읽기 실패를 '활성 0명·대화 0건'으로 보였고 글자 토큰 값을 그대로 더했다 → 503·숫자만.
 */

const state: {
  orgs: { data: unknown; error: unknown };
  paged: Array<{ data: unknown; error: unknown }>;
  month: Map<string, number> | null;
  monthCalls: string[];
} = { orgs: { data: [], error: null }, paged: [], month: new Map(), monthCalls: [] };

vi.mock('@/lib/super-auth', () => ({ getSuperAdminFromRequest: () => ({ id: 's1' }) }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: () => {
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'gte', 'lte', 'order', 'range']) b[n] = () => b;
      b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(state.orgs).then(ok, bad);
      return b;
    },
  },
}));
vi.mock('@/lib/paged-select', () => ({ pagedRows: async () => state.paged.shift() ?? { data: [], error: null } }));
vi.mock('@/lib/org-chat-tokens', async (orig) => ({
  ...(await orig<typeof import('@/lib/org-chat-tokens')>()),
  loadChatTokensByOrg: async (from: string) => { state.monthCalls.push(from); return state.month; },
}));

import { GET as usageGET } from '@/app/api/super/usage/route';
import { GET as realtimeGET } from '@/app/api/super/usage/realtime/route';

const req = (q: string) => ({ url: `http://x/api/super/usage?${q}` }) as never;
const ORG = { id: 'o1', name: '기관', plan: 'basic', monthly_token_limit: 1000, status: 'active' };
const now = new Date().toISOString();

beforeEach(() => {
  state.orgs = { data: [ORG], error: null };
  state.paged = [];
  state.month = new Map([['o1', 800]]);
  state.monthCalls = [];
});

describe('기관별 한도 사용률', () => {
  it("'오늘'을 골라도 이번 달 토큰으로 — 오늘 100이어도 이번 달 800이면 80%", async () => {
    state.paged = [{ data: [{ action: 'chat_message', organization_id: 'o1', user_id: 'u1', details: { input_tokens: 60, output_tokens: 40 }, created_at: now }], error: null }];
    const res = await usageGET(req('period=today'));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.orgStats[0]).toMatchObject({ totalTokens: 100, monthTokens: 800, tokenLimit: 1000, usagePercent: 80 });
    expect(state.monthCalls).toHaveLength(1);
  });
  it("'이번 달'·전체 기관이면 읽은 기록으로 바로 셈(한 번 더 읽지 않음)", async () => {
    state.paged = [{ data: [{ action: 'chat_message', organization_id: 'o1', user_id: 'u1', details: { input_tokens: 300, output_tokens: 200 }, created_at: now }], error: null }];
    const body = await (await usageGET(req('period=month'))).json();
    expect(body.data.orgStats[0]).toMatchObject({ monthTokens: 500, usagePercent: 50 });
    expect(state.monthCalls).toHaveLength(0);
  });
  it('이번 달 토큰을 못 읽으면 500 — 0%로 보이지 않음', async () => {
    state.month = null;
    const res = await usageGET(req('period=week'));
    expect(res.status).toBe(500);
    expect((await res.json()).ok).toBe(false);
  });
  it("기관 목록을 못 읽으면 500 — '알 수 없음'·'한도 없음'으로 보이지 않음", async () => {
    state.orgs = { data: null, error: { code: 'XX000', message: 'boom' } };
    const res = await usageGET(req('period=month'));
    expect(res.status).toBe(500);
  });
});

describe('실시간 카드', () => {
  it('못 읽으면 503', async () => {
    state.paged = [{ data: null, error: { message: 'boom' } }];
    const res = await realtimeGET(req(''));
    expect(res.status).toBe(503);
  });
  it('토큰은 숫자만 더함', async () => {
    state.paged = [{ data: [
      { user_id: 'u1', details: { input_tokens: 10, output_tokens: 5 }, created_at: now },
      { user_id: 'u2', details: { input_tokens: '7', output_tokens: 3 }, created_at: now },
    ], error: null }];
    const body = await (await realtimeGET(req(''))).json();
    expect(body.data).toMatchObject({ lastHourTokens: 18, lastHourConversations: 2, activeNow: 2 });
  });
});

describe('화면', () => {
  const s = readFileSync('src/app/super/usage/page.tsx', 'utf8');
  it('열 이름이 이번 달임을 밝힘', () => {
    expect(s).toContain("'이번 달 한도 사용률'");
    expect(s).toContain('이번달한도사용률(%)');
  });
  it('못 읽으면 지난 숫자 대신 안내', () => {
    expect(s).toContain("else { setData(null); setLoadError('사용량을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.'); }");
    expect(s).toContain('{loadError && (');
  });
});
