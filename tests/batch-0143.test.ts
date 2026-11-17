import { readFileSync } from 'fs';
import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * 2026-11-17 — 기관의 '이번 달 토큰'을 한 규칙으로. 슈퍼관리자 기관 목록은 DB 뷰(모든 활동·UTC 달)라 기관 상세·한도 판정
 * (`organization_chat_tokens` — chat_message·한국 시간 이번 달)과 숫자가 달랐고(운영 '기본 기관' 10,820 vs 10,697),
 * 대시보드는 같은 이번 달 기록을 세 번 따로 읽었으며 숫자가 아닌 값도 그대로 더했다.
 */

const state: { rpc: Record<string, unknown>; rpcErr: Set<string>; logs: { data: unknown; error: unknown } } = { rpc: {}, rpcErr: new Set(), logs: { data: [], error: null } };

vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    rpc: async (_fn: string, args: { p_organization_id: string }) =>
      state.rpcErr.has(args.p_organization_id) ? { data: null, error: { code: 'X' } } : { data: state.rpc[args.p_organization_id] ?? 0, error: null },
    from: () => ({}),
  },
}));
vi.mock('@/lib/paged-select', () => ({ pagedRows: async () => state.logs }));

import { chatTokensOf, loadChatTokensByOrg, orgChatTokens, sumByOrg } from '@/lib/org-chat-tokens';

beforeEach(() => { state.rpc = {}; state.rpcErr = new Set(); state.logs = { data: [], error: null }; });

describe('셈 — DB 함수와 같이 숫자만', () => {
  it('입력+출력, 숫자가 아니면 0', () => {
    expect(chatTokensOf({ input_tokens: 100, output_tokens: 23 })).toBe(123);
    expect(chatTokensOf({ input_tokens: '100', output_tokens: 23 })).toBe(23); // 예전 셈은 '10023'(글 잇기)
    expect(chatTokensOf({ input_tokens: NaN })).toBe(0);
    expect(chatTokensOf(null)).toBe(0);
    expect(chatTokensOf('x')).toBe(0);
  });
  it('기관별 합 — 기관 없는 기록은 뺌', () => {
    const m = sumByOrg([
      { organization_id: 'a', details: { input_tokens: 1, output_tokens: 2 } },
      { organization_id: 'a', details: { input_tokens: 10 } },
      { organization_id: null, details: { input_tokens: 99 } },
      { organization_id: 'b', details: {} },
    ]);
    expect(Object.fromEntries(m)).toEqual({ a: 13, b: 0 });
  });
  it('기록을 못 읽으면 null(빈 것으로 꾸미지 않음)', async () => {
    state.logs = { data: null, error: { code: 'X' } };
    expect(await loadChatTokensByOrg('2026-11-01T00:00:00Z')).toBeNull();
    state.logs = { data: [{ organization_id: 'a', details: { input_tokens: 5, output_tokens: 5 } }], error: null };
    expect(Object.fromEntries((await loadChatTokensByOrg('x'))!)).toEqual({ a: 10 });
  });
  it('목록 한 쪽은 DB 함수로 — 못 읽은 기관은 값 없음', async () => {
    state.rpc = { a: 10697, b: '42' };
    state.rpcErr = new Set(['c']);
    expect(Object.fromEntries(await orgChatTokens(['a', 'b', 'c'], 'x'))).toEqual({ a: 10697, b: 42 });
  });
});

describe('쓰는 곳', () => {
  it('기관 목록은 뷰 값 대신 같은 셈(못 읽으면 —)', () => {
    const r = readFileSync('src/app/api/super/organizations/route.ts', 'utf8');
    expect(r).toContain('orgChatTokens(');
    expect(r).toContain('tokens_this_month: tokens.has(o.id) ? tokens.get(o.id) : null');
    const p = readFileSync('src/app/super/organizations/page.tsx', 'utf8');
    expect(p).toContain("typeof org.tokens_this_month === 'number' ? formatTokens(org.tokens_this_month) : '—'");
  });
  it('대시보드는 이번 달 기록을 한 번만 읽는다', () => {
    const s = readFileSync('src/app/api/super/dashboard/route.ts', 'utf8');
    expect(s.match(/loadChatTokensByOrg\(monthStart\)/g)?.length).toBe(1);
    expect(s.match(/await monthTokensP/g)?.length).toBe(3);
    expect(s).not.toMatch(/input_tokens \?\? 0\) \+ \(l\.details/);
  });
  it('사용량 경보도 같은 셈, 못 읽으면 503', () => {
    const s = readFileSync('src/app/api/super/usage/alerts/route.ts', 'utf8');
    expect(s).toContain('loadChatTokensByOrg(monthStart)');
    expect(s).toContain('status: 503');
  });
});
