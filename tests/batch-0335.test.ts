// tests/batch-0335.test.ts
// 앱 결과 바로 보내기(2026-11-27, 마이그레이션 없음) — 실행이 끝나 넣은 보내기를 그 답변의 것만 그 자리에서 한 번. 실패하면 5분 실행기가 다시.
import { describe, expect, it, vi } from 'vitest';
import { deliverNow, dispatchDueDeliveries, type OutboundDeps } from '@/lib/apps/outbound/deliver';

function deps(over: Partial<OutboundDeps> = {}) {
  const d: OutboundDeps = {
    now: () => Date.parse('2026-11-27T00:00:00Z'),
    listDue: vi.fn(async () => []),
    claim: vi.fn(async () => true),
    load: vi.fn(async () => null),
    finish: vi.fn(async () => {}),
    decrypt: (s) => s,
    checkHost: vi.fn(async () => ({ ok: true }) as never),
    post: vi.fn(async () => ({ kind: 'sent', status: 200 }) as never),
    log: vi.fn(async () => {}),
    expireApprovals: vi.fn(async () => 0),
    ...over,
  };
  return d;
}

describe('바로 보내기', () => {
  it('그 답변의 보내기만 묻고, 확인 기한 정리는 하지 않는다', async () => {
    const d = deps();
    await deliverNow('m1', d);
    expect(d.listDue).toHaveBeenCalledWith(expect.any(String), expect.any(String), 3, 'm1');
    expect(d.expireApprovals).not.toHaveBeenCalled();
  });
  it('5분 실행기는 예전처럼 — 답변을 가리지 않고 확인 기한 정리도', async () => {
    const d = deps();
    await dispatchDueDeliveries(d);
    expect(d.listDue).toHaveBeenCalledWith(expect.any(String), expect.any(String), 20, undefined);
    expect(d.expireApprovals).toHaveBeenCalled();
  });
  it('던지지 않는다', async () => {
    await expect(deliverNow('m1', deps({ listDue: async () => { throw new Error('db'); } }))).resolves.toMatchObject({ claimed: 0 });
    await expect(deliverNow('m1', { now: () => { throw new Error('x'); } } as unknown as OutboundDeps)).resolves.toBeNull();
  });
});
