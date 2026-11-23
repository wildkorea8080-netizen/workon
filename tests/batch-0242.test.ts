import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-21 — 앱 결과를 외부로 보낼 때 일괄 실행 묶음 번호를 못 읽은 것을 '번호 없음'으로 보지 않는다.
 * 입력형 앱 외부 연동의 비동기 호출(0087)은 202 응답의 `batch_id`를 돌려주고, 결과는 '결과 보낼 곳'으로 몸의 `run.batch_id`에
 * 그 번호를 실어 간다 — 외부 시스템은 이 번호로 결과를 자기 요청과 맞춘다(이것이 콜백). 예전엔 줄(app_batch_items)을 못 읽으면
 * 번호 없이 보냈다: 받는 쪽은 2xx로 받고 '보냄'이 되어 다시 가지 않으니, 그 결과는 외부 시스템이 어느 요청의 것인지 알 수 없었다.
 * 이제 그 읽기 실패도 보낼 곳·결과를 못 읽은 것과 같이 다음 차례에 다시 본다(시도 수를 세지 않음).
 */

const state = vi.hoisted(() => ({ batchError: null as unknown, batchRow: null as unknown }));

vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'limit']) b[n] = () => b;
      b.maybeSingle = async () => {
        if (table === 'app_outbound_endpoints') return { data: { url: 'https://recv.example.go.kr/hook', secret_encrypted: 'x', organization_id: 'o1', revoked_at: null, actions: [] }, error: null };
        if (table === 'messages') return { data: { content: '결과', conversation_id: 'c1', created_at: '2026-11-21T00:00:00Z', role: 'assistant', source_references: {}, agent_version: 1 }, error: null };
        if (table === 'agents') return { data: { id: 'a1', name: '앱', app_definition: {} }, error: null };
        if (table === 'app_batch_items') return { data: state.batchError ? null : state.batchRow, error: state.batchError };
        return { data: null, error: null };
      };
      return b;
    },
  },
}));

import { outboundDeps, dispatchDueDeliveries } from '@/lib/apps/outbound/deliver';

const row = { id: 'd1', organization_id: 'o1', endpoint_id: 'e1', agent_id: 'a1', message_id: 'm1', status: 'pending', attempts: 0, claimed_at: null, action: null } as never;

beforeEach(() => { state.batchError = null; state.batchRow = null; });

describe('outboundDeps().load — 묶음 번호', () => {
  it('일괄 실행 줄이 낸 결과면 그 묶음 번호', async () => {
    state.batchRow = { batch_id: 'b1' };
    expect((await outboundDeps().load(row))?.batchId).toBe('b1');
  });
  it('일괄 실행이 아니면 번호 없이(읽었고 줄이 없음)', async () => {
    const ctx = await outboundDeps().load(row);
    expect(ctx).not.toBeNull();
    expect(ctx?.batchId).toBeNull();
  });
  it('줄을 못 읽으면 번호 없이 보내지 않고 읽기 실패(null)', async () => {
    state.batchError = { code: '57014', message: 'timeout' };
    expect(await outboundDeps().load(row)).toBeNull();
  });
});

describe('읽기 실패는 다음 차례에 다시(시도 수를 세지 않고 보내지 않음)', () => {
  it('load가 null이면 pending으로 되돌리고 보내지 않는다', async () => {
    const finish = vi.fn(async () => {});
    const post = vi.fn();
    const result = await dispatchDueDeliveries({
      now: () => Date.parse('2026-11-21T00:00:00Z'),
      listDue: async () => [row],
      claim: async () => true,
      load: async () => null,
      finish,
      post,
    } as never);
    expect(post).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith('d1', expect.objectContaining({ status: 'pending', attempts: 0 }));
    expect(result.retried).toBe(1);
  });
});
