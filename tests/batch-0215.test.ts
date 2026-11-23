import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-20 — 앱 일괄 실행 마침 메일이 받는 사람·확인 기다림 수를 못 읽으면 던진다.
 * 예전엔 ① 만든 직원의 주소 읽기 실패를 '주소 없음'으로 보아 메일 없이 조용히 끝났고(기록도 없음),
 * ② 보내기 전 확인을 기다리는 결과 수 읽기 실패를 0건으로 보아, 확인할 결과가 있어도 메일에 없다고 적었다.
 * 이제 던져 실행기가 '마침 메일을 보내지 못했습니다'로 운영 기록에 남긴다.
 */

const state = vi.hoisted(() => ({ userError: null as unknown, countError: null as unknown, sent: [] as string[] }));

vi.mock('@/lib/mailer', async (orig) => ({
  ...(await orig<typeof import('@/lib/mailer')>()),
  isMailConfigured: () => true,
  sendBatchFinishedEmail: async (to: string) => { state.sent.push(to); return { sent: true }; },
}));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'is', 'in', 'order', 'limit']) b[n] = () => b;
      const result = () => {
        if (table === 'app_batches') return { data: { id: 'b1', user_id: 'u1', agent_id: 'a1', name: '묶음', status: 'done', total: 2, stop_reason: null, finished_at: '2026-11-20T03:00:00Z', source: 'manual' }, error: null };
        if (table === 'app_batch_items') return { data: [{ status: 'done', message_id: 'm1' }, { status: 'done', message_id: 'm2' }], error: null };
        if (table === 'users') return { data: state.userError ? null : { email: 'u1@org.go.kr' }, error: state.userError };
        if (table === 'agents') return { data: { name: '앱' }, error: null };
        if (table === 'app_outbound_deliveries') return { data: null, count: state.countError ? null : 1, error: state.countError };
        return { data: null, error: null };
      };
      b.maybeSingle = async () => result();
      b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, bad);
      return b;
    },
  },
}));

import { notifyBatchFinished } from '@/lib/apps/batches';

beforeEach(() => { state.userError = null; state.countError = null; state.sent = []; });

describe('일괄 실행 마침 메일', () => {
  it('읽히면 보낸다', async () => {
    expect(await notifyBatchFinished('b1')).toBe(true);
    expect(state.sent).toEqual(['u1@org.go.kr']);
  });
  it('직원 주소를 못 읽으면 던진다(조용히 건너뛰지 않음)', async () => {
    state.userError = { code: 'XX000', message: 'boom' };
    await expect(notifyBatchFinished('b1')).rejects.toThrow('users');
    expect(state.sent).toEqual([]);
  });
  it('확인 기다림 수를 못 읽으면 던진다(0건으로 적지 않음)', async () => {
    state.countError = { code: 'XX000', message: 'boom' };
    await expect(notifyBatchFinished('b1')).rejects.toThrow('app_outbound_deliveries');
    expect(state.sent).toEqual([]);
  });
});
