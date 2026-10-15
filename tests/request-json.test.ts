import { describe, it, expect, vi, afterEach } from 'vitest';
import { requestJson, NETWORK_ERROR_MESSAGE } from '@/lib/request-json';

afterEach(() => vi.unstubAllGlobals());

describe('requestJson', () => {
  it('JSON 응답은 상태와 본문을 그대로 돌려준다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, data: 1 }), { status: 200 })));
    expect(await requestJson('/x')).toEqual({ status: 200, r: { ok: true, data: 1 } });
  });

  it('409 같은 오류 응답의 상태도 남긴다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: false, error: { message: 'm', details: { reason: 'conflict' } } }), { status: 409 }))
    );
    const { status, r } = await requestJson('/x');
    expect(status).toBe(409);
    expect(r.error?.details?.reason).toBe('conflict');
  });

  it('네트워크 오류는 던지지 않고 안내 문구로 바꾼다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await requestJson('/x')).toEqual({ status: 0, r: { ok: false, error: { message: NETWORK_ERROR_MESSAGE } } });
  });

  it('JSON이 아닌 응답(504 등)도 안내 문구로 바꾼다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Gateway Timeout</html>', { status: 504 })));
    const { status, r } = await requestJson('/x');
    expect(status).toBe(504);
    expect(r).toEqual({ ok: false, error: { message: NETWORK_ERROR_MESSAGE } });
  });
});
