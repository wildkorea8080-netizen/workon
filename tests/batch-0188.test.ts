import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-19 — 슈퍼관리자 화면의 원가는 모든 활동으로.
 * 예전: 대시보드 '예상 비용'·계약 '월별 매출 / API 비용'·사용량·기관 상세 사용량이 `chat_message`만 읽어
 * 업무 작업·답변 평가·프롬프트 다듬기·대화 제목 같은 모델 호출의 원가가 빠졌다(예산 판정은 모든 활동을 센다).
 * 대화 수·토큰(한도와 같은 셈)은 그대로 chat_message만.
 */

type Row = { action: string; organization_id: string | null; user_id: string | null; details: Record<string, unknown>; created_at: string };
const state = { logs: [] as Row[], filters: [] as Array<[string, unknown]> };

vi.mock('@/lib/super-auth', () => ({ getSuperAdminFromRequest: () => ({ sub: 'sa' }) }));
vi.mock('@/lib/org-chat-tokens', async (orig) => ({
  ...(await orig<typeof import('@/lib/org-chat-tokens')>()),
  loadChatTokensByOrg: vi.fn(async () => new Map()),
}));
vi.mock('@/lib/paged-select', () => ({
  pagedRows: async (fn: (a: number, b: number, w: boolean) => unknown) => {
    fn(0, 999, true); // 조건을 기록하게 한 번 부른다
    return { data: state.logs, error: null };
  },
}));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'gte', 'lte', 'lt', 'order', 'range', 'in', 'not']) b[n] = () => b;
      b.eq = (col: string, v: unknown) => { if (table === 'usage_logs') state.filters.push([col, v]); return b; };
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(
        table === 'organizations' ? { data: [{ id: 'o1', name: '가', plan: 'basic', monthly_token_limit: 0, status: 'active' }], error: null }
        : table === 'contracts' ? { data: [], error: null }
        : { data: [], error: null },
      ).then(res);
      return b;
    },
  },
}));

import { isChatRow, tokenNumber } from '@/lib/cost-rows';
import { GET as superUsage } from '@/app/api/super/usage/route';
import { GET as orgUsage } from '@/app/api/super/organizations/[id]/usage/route';
import { GET as revenue } from '@/app/api/super/contracts/revenue/route';

const now = new Date().toISOString();
const row = (action: string, cost: number, tokens = 100): Row => ({
  action, organization_id: 'o1', user_id: 'u1', created_at: now,
  details: { model: 'claude-sonnet-4-6', input_tokens: tokens, output_tokens: 0, cost_usd: cost },
});

beforeEach(() => {
  state.filters = [];
  state.logs = [row('chat_message', 1), row('work_generate', 2, 5000), row('rag_eval_answer', 0.5, 300), row('file_attached', 0, 0)];
});

describe('cost-rows', () => {
  it('chat만 대화로, 토큰은 숫자만', () => {
    expect(state.logs.filter(isChatRow)).toHaveLength(1);
    expect([tokenNumber(5), tokenNumber('5'), tokenNumber(NaN), tokenNumber(undefined)]).toEqual([5, 0, 0, 0]);
  });
});

describe('사용량 모니터링', () => {
  it('원가는 모든 활동, 대화·토큰은 chat_message만, 활동으로 거르지 않음', async () => {
    const body = await (await superUsage(new Request('http://x/?period=month') as never)).json();
    expect(body.data.summary).toMatchObject({ totalConversations: 1, totalInputTokens: 100, estimatedCostUsd: 3.5 });
    expect(body.data.orgStats[0]).toMatchObject({ conversations: 1, estimatedCost: 3.5 });
    expect(state.filters.some(([c]) => c === 'action')).toBe(false);
  });
});

describe('기관 상세 사용량', () => {
  it('원가는 모든 활동', async () => {
    const body = await (await orgUsage(new Request('http://x/') as never, { params: { id: 'o1' } })).json();
    expect(body.data.summary).toMatchObject({ conversations: 1, totalTokens: 100, costUsd: 3.5, activeUsers: 1 });
    expect(state.filters).toEqual([['organization_id', 'o1']]);
  });
});

describe('계약 매출 / API 비용', () => {
  it('이번 달 API 비용은 모든 활동, 글자 토큰은 0', async () => {
    state.logs.push({ ...row('prompt_enhance', 0, 0), details: { input_tokens: '999', output_tokens: 'x', cost_usd: 0 } });
    const body = await (await revenue(new Request('http://x/') as never)).json();
    expect(body.data.annual.totalCostUsd).toBe(3.5);
    const m = body.data.monthly.find((x: { apiCostUsd: number }) => x.apiCostUsd > 0);
    expect(m).toMatchObject({ apiCostUsd: 3.5, inpTokens: 5400, outTokens: 0 });
    expect(state.filters.some(([c]) => c === 'action')).toBe(false);
  });
});

describe('원본 확인 — 대시보드', () => {
  it('이번 달 기록은 모든 활동, 대화 수·토큰은 chat만', () => {
    const s = readFileSync('src/app/api/super/dashboard/route.ts', 'utf8');
    expect(s).toContain(".select('action, details', w ? { count: 'exact' } : undefined).gte('created_at', monthStart)");
    expect(s).toContain('const monthChat = (monthUsage.data ?? []).filter(isChatRow);');
    expect(s).toContain('sumCostUsd(monthUsage.data ?? [])');
  });
});
