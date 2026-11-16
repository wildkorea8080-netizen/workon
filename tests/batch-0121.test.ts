import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ errors: [] as Array<null | { code?: string }>, updates: 0, logs: [] as Record<string, unknown>[] }));

vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: () => {
      const chain: Record<string, unknown> = {};
      chain.update = () => chain;
      chain.eq = () => chain;
      chain.then = (resolve: (v: unknown) => unknown) => { state.updates++; return Promise.resolve({ error: state.errors.shift() ?? null }).then(resolve); };
      return chain;
    },
  },
}));
vi.mock('@/lib/logger', () => ({ logSystem: async (p: Record<string, unknown>) => { state.logs.push(p); } }));

import { outboundDeps } from '@/lib/apps/outbound/deliver';

/**
 * 2026-11-17 — 앱 결과 보내기의 결과를 못 적으면 기록이 'sending'에 남아 10분 뒤 받는 쪽에 같은 결과가 또 갔다(돌려준 오류를 보지 않음).
 * 한 번 더 해 보고, 그래도 안 되면 운영 기록에. 대리 접근 끝난 때도 못 적으면 운영 기록에.
 */

beforeEach(() => { state.errors = []; state.updates = 0; state.logs = []; });

describe('보내기 결과 기록', () => {
  it('되면 한 번, 운영 기록 없음', async () => {
    await outboundDeps().finish('D1', { status: 'sent', attempts: 1, last_status: 200, last_error: null });
    expect(state.updates).toBe(1);
    expect(state.logs).toEqual([]);
  });
  it('한 번 실패하면 다시 해서 되면 끝', async () => {
    state.errors = [{ code: '57014' }, null];
    await outboundDeps().finish('D1', { status: 'sent', attempts: 1, last_status: 200, last_error: null });
    expect(state.updates).toBe(2);
    expect(state.logs).toEqual([]);
  });
  it('두 번 다 실패하면 critical 운영 기록(보낸 기록 id·상태·코드만)', async () => {
    state.errors = [{ code: '57014' }, { code: '57014' }];
    await outboundDeps().finish('D1', { status: 'sent', attempts: 1, last_status: 200, last_error: null });
    expect(state.updates).toBe(2);
    expect(state.logs).toEqual([{ level: 'critical', category: 'api', message: '앱 결과 보내기의 결과를 기록하지 못했습니다(10분 뒤 다시 보낼 수 있음)', details: { delivery_id: 'D1', status: 'sent', code: '57014' } }]);
  });
});

describe('대리 접근 끝난 때', () => {
  it('돌려준 오류를 운영 기록에', () => {
    const src = readFileSync('src/app/api/super/impersonate/end/route.ts', 'utf8');
    expect(src).toContain('const { error: endError } = await supabaseAdmin');
    expect(src).toContain("message: '대리 접근 끝난 때를 기록하지 못했습니다'");
  });
});
