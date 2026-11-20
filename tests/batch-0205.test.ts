import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-19 — 일괄 실행 결과 엑셀이 읽기 실패를 '없음'으로 꾸미지 않는다.
 * ① 외부로 보낸 상태·접수 번호(0076·0080)를 못 읽으면 열 없이 만들었다 — 그 열은 보낸 줄이 있을 때만 생기므로
 *    받은 사람은 '외부로 보내지 않았다'로 읽는다.
 * ② 앱(입력 항목 이름)을 못 읽으면 열 이름을 입력 키(`dept`)로 바꿔 만들었다.
 */

const state = {
  deliveries: new Map() as Map<number, unknown> | null,
  agentError: null as unknown,
  workbook: vi.fn(async (_x: unknown) => Buffer.from('x')),
};

vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => ({ user: { id: 'u1' } }) }));
vi.mock('@/lib/config', () => ({ APP_URL: 'https://x' }));
vi.mock('@/lib/apps/definition', () => ({
  validateAppDefinition: (v: unknown) => ({ ok: true, value: v }),
}));
vi.mock('@/lib/apps/batches', () => ({
  BatchReadError: class extends Error {},
  getBatch: async () => ({ batch: { name: '묶음', agentId: 'a1' }, items: [{ position: 1, inputs: { dept: '총무과' } }] }),
  loadBatchResults: async () => new Map([[1, '답']]),
  loadBatchDeliveries: async () => {
    if (state.deliveries === null) throw new Error('down');
    return state.deliveries;
  },
  batchWorkbook: (x: unknown) => state.workbook(x),
}));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = async () => ({
        data: state.agentError ? null : { app_definition: { fields: [{ key: 'dept', label: '부서' }] } },
        error: state.agentError,
      });
      return b;
    },
  },
}));

import { GET } from '@/app/api/apps/batches/[id]/export/route';

const get = () => GET(new Request('http://x') as never, { params: { id: 'b1' } });

beforeEach(() => { state.deliveries = new Map(); state.agentError = null; state.workbook.mockClear(); });

describe('일괄 실행 결과 엑셀', () => {
  it('보낸 결과를 못 읽으면 엑셀을 만들지 않고 503', async () => {
    state.deliveries = null;
    const res = await get();
    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toContain('외부로 보낸 결과를 지금 읽지 못했습니다');
    expect(state.workbook).not.toHaveBeenCalled();
  });
  it('앱을 못 읽으면 열 이름을 키로 꾸미지 않고 503', async () => {
    state.agentError = { code: 'XX000' };
    const res = await get();
    expect(res.status).toBe(503);
    expect(state.workbook).not.toHaveBeenCalled();
  });
  it('둘 다 읽으면 입력 항목 이름으로 만든다', async () => {
    state.deliveries = new Map([[1, { status: 'sent', receiptRef: 'R-1' }]]);
    const res = await get();
    expect(res.status).toBe(200);
    const arg = state.workbook.mock.calls[0][0] as { fields: Array<{ label: string }>; items: Array<{ delivery: unknown }> };
    expect(arg.fields).toEqual([{ key: 'dept', label: '부서' }]);
    expect(arg.items[0].delivery).toEqual({ status: 'sent', receiptRef: 'R-1' });
  });
});
