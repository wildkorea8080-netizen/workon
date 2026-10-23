import { describe, expect, it, vi } from 'vitest';
import {
  NODA_CONTEXT_BUDGET,
  NODA_MIN_SIMILARITY,
  NodaError,
  createNodaClient,
  documentIdFromNodaFilename,
  nodaFilename,
  nodaTenant,
  stripNodaPrefixes,
} from '@/lib/noda';

const ID = '11111111-2222-4333-8444-555555555555';
const KEY = 'k-secret';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** 가짜 시계 — sleep이 시계를 앞으로 보낸다. */
function fakeClock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}

function client(fetchImpl: typeof fetch, clock = fakeClock(), apiKey = KEY) {
  return {
    clock,
    noda: createNodaClient({
      baseUrl: 'https://noda.test/',
      apiKey,
      fetch: fetchImpl,
      sleep: clock.sleep,
      now: clock.now,
    }),
  };
}

describe('이름 규칙', () => {
  it('보관함 이름은 비서 id로만 — 하이픈을 뺀 32자', () => {
    expect(nodaTenant('3f2a1b4c-0000-4000-8000-00000000abcd')).toBe('workon-a3f2a1b4c00004000800000000000abcd');
    expect(nodaTenant('3F2A1B4C-0000-4000-8000-00000000ABCD')).toBe('workon-a3f2a1b4c00004000800000000000abcd');
    expect(() => nodaTenant('../workon')).toThrow();
    expect(() => nodaTenant('')).toThrow();
  });

  it('NODA 파일 이름은 문서 id + 원래 이름, 확장자를 지킨다', () => {
    expect(nodaFilename(ID, '2026 예산(최종).CSV')).toBe(`${ID}__2026 예산(최종).CSV`);
    expect(nodaFilename(ID, 'a/b\\c.txt')).toBe(`${ID}__a_b_c.txt`);
    expect(nodaFilename(ID, 'a\u0000b\nc.pdf')).toBe(`${ID}__a_b_c.pdf`);
    expect(documentIdFromNodaFilename(`${ID}__x.pdf`)).toBe(id());
    expect(documentIdFromNodaFilename('x.pdf')).toBeNull();
    expect(documentIdFromNodaFilename(`${ID.toUpperCase()}__x.pdf`)).toBe(id());
  });

  it('근거 글에서 문서 id 앞부분을 모두 뗀다', () => {
    expect(stripNodaPrefixes(`[1] ${ID}__규정.hwp p.3\n[2] ${ID}__표.xlsx!A1:B2`)).toBe(
      '[1] 규정.hwp p.3\n[2] 표.xlsx!A1:B2',
    );
    expect(stripNodaPrefixes('앞부분이 없는 글')).toBe('앞부분이 없는 글');
  });
});

function id() {
  return ID;
}

describe('NODA 클라이언트', () => {
  it('업로드는 항상 replace=1, X-Filename 인코딩, Bearer', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return json({ tenant: 't', filename: 'f', bytes: 3, stored: true, doc_id: 'd1', readable: true, reason: null, chunks: 4 });
    }) as unknown as typeof fetch;
    const { noda } = client(f);
    const name = nodaFilename(ID, '2026 예산(최종).CSV');
    const res = await noda.uploadDocument({ tenant: 'workon-aabc', filename: name, bytes: new Uint8Array([1, 2, 3]) });

    expect(res.readable).toBe(true);
    expect(res.chunks).toBe(4);
    expect(calls).toHaveLength(1);
    const u = new URL(calls[0].url);
    expect(u.origin + u.pathname).toBe('https://noda.test/documents/upload');
    expect(u.searchParams.get('tenant')).toBe('workon-aabc');
    expect(u.searchParams.get('replace')).toBe('1');
    const h = new Headers(calls[0].init.headers);
    expect(h.get('x-filename')).toBe(encodeURIComponent(name));
    expect(h.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(calls[0].init.method).toBe('POST');
  });

  it('503 두 번 뒤 성공하면 결과를 돌려준다(업로드 창 1분 안)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ error: 'busy' }, 503))
      .mockResolvedValueOnce(json({ error: 'busy' }, 503))
      .mockResolvedValueOnce(json({ stored: true, readable: true, chunks: 1 }));
    const { noda, clock } = client(fetchMock as unknown as typeof fetch);
    const res = await noda.uploadDocument({ tenant: 't', filename: 'f.txt', bytes: new Uint8Array() });
    expect(res.stored).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(clock.sleeps).toEqual([3000, 3000]);
  });

  it('Retry-After가 창을 넘기면 기다리지 않고 NodaError(http, 429)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ error: 'slow down' }, 429, { 'retry-after': '120' }));
    const { noda, clock } = client(fetchMock as unknown as typeof fetch);
    const err = await noda
      .uploadDocument({ tenant: 't', filename: 'f.txt', bytes: new Uint8Array() })
      .catch((e) => e);
    expect(err).toBeInstanceOf(NodaError);
    expect(err.code).toBe('http');
    expect(err.status).toBe(429);
    expect(clock.sleeps).not.toContain(120_000);
    expect(clock.sleeps).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('Retry-After가 창 안이면 그 초만큼 기다린다', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({}, 429, { 'retry-after': '7' }))
      .mockResolvedValueOnce(json({ documents: [] }));
    const { noda, clock } = client(fetchMock as unknown as typeof fetch);
    await noda.listDocuments('t');
    expect(clock.sleeps).toEqual([7000]);
  });

  it('401은 다시 시도하지 않는다', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ error: 'bad key' }, 401));
    const { noda } = client(fetchMock as unknown as typeof fetch);
    const err = await noda.listDocuments('t').catch((e) => e);
    expect(err).toBeInstanceOf(NodaError);
    expect(err.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('getContext는 budget 4000·min_similarity 0.8을 싣고, 10초 창을 2.5초 간격으로', async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      throw new TypeError('fetch failed');
    });
    const { noda, clock } = client(fetchMock as unknown as typeof fetch);
    const err = await noda.getContext({ tenant: 'workon-a1', query: '여비 규정' }).catch((e) => e);
    expect(err).toBeInstanceOf(NodaError);
    expect(err.code).toBe('network');
    expect(bodies[0]).toEqual({ tenant: 'workon-a1', query: '여비 규정', budget: 4000, min_similarity: 0.8 });
    expect(NODA_CONTEXT_BUDGET).toBe(4000);
    expect(clock.sleeps.every((s) => s === 2500)).toBe(true);
    expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(clock.sleeps.length + 1);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(2);
  });

  it('getContext 응답에 dropped가 없으면 0, sources가 없으면 []', async () => {
    const { noda } = client((async () => json({ context: '' })) as unknown as typeof fetch);
    const r = await noda.getContext({ tenant: 't', query: 'q' });
    expect(r).toEqual({ context: '', sources: [], dropped: 0 });
  });

  it('getContext는 근거를 그대로 돌려준다', async () => {
    const src = { n: 1, chunk_id: 'c1', doc_id: 'd1', filename: `${ID}__a.pdf`, similarity: 0.9, anchors: [{ page: 2 }] };
    const { noda } = client((async () => json({ context: '[1] ...', sources: [src], dropped: 3 })) as unknown as typeof fetch);
    const r = await noda.getContext({ tenant: 't', query: 'q' });
    expect(r.sources).toEqual([src]);
    expect(r.dropped).toBe(3);
  });

  it('요청 시간 제한(timeout)은 다시 시도하지 않는다', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const fetchMock = vi.fn().mockRejectedValue(timeout);
    const { noda, clock } = client(fetchMock as unknown as typeof fetch);
    const err = await noda.getContext({ tenant: 't', query: 'q' }).catch((e) => e);
    expect(err).toBeInstanceOf(NodaError);
    expect(err.code).toBe('timeout');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('deleteDocument 404는 deleted:false로 끝난다', async () => {
    const calls: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`);
      return json({ error: 'not found' }, 404);
    }) as unknown as typeof fetch;
    const { noda } = client(f);
    expect(await noda.deleteDocument('workon-a1', `${ID}__a b.pdf`)).toEqual({ deleted: false });
    expect(calls).toHaveLength(1);
    const u = new URL(calls[0].split(' ')[1]);
    expect(calls[0].startsWith('DELETE ')).toBe(true);
    expect(u.searchParams.get('tenant')).toBe('workon-a1');
    expect(u.searchParams.get('filename')).toBe(`${ID}__a b.pdf`);
  });

  it('deleteDocument 성공은 deleted:true', async () => {
    const { noda } = client((async () => json({ ok: true })) as unknown as typeof fetch);
    expect(await noda.deleteDocument('t', 'f')).toEqual({ deleted: true });
  });

  it('listDocuments는 receiving이 없어도 빈 배열', async () => {
    const { noda } = client((async () => json({ documents: [{ filename: 'a', doc_id: 'd', extra: 1 }] })) as unknown as typeof fetch);
    const r = await noda.listDocuments('t');
    expect(r.documents).toEqual([{ filename: 'a', doc_id: 'd' }]);
    expect(r.receiving).toEqual([]);
    const { noda: n2 } = client((async () => json({})) as unknown as typeof fetch);
    expect(await n2.listDocuments('t')).toEqual({ documents: [], receiving: [] });
  });

  it('listDocuments는 receiving의 이름·초를 읽는다', async () => {
    const { noda } = client((async () => json({ documents: [], receiving: [{ filename: 'x', seconds: 12 }] })) as unknown as typeof fetch);
    expect((await noda.listDocuments('t')).receiving).toEqual([{ filename: 'x', seconds: 12 }]);
  });

  it('getHealth는 응답 본문을 돌려준다', async () => {
    const { noda } = client((async () => json({ status: 'ok' })) as unknown as typeof fetch);
    expect(await noda.getHealth()).toEqual({ status: 'ok' });
  });

  it('키가 비면 fetch 없이 NodaError(missing_key)', async () => {
    const fetchMock = vi.fn();
    const { noda } = client(fetchMock as unknown as typeof fetch, fakeClock(), '');
    for (const call of [
      () => noda.listDocuments('t'),
      () => noda.getContext({ tenant: 't', query: 'q' }),
      () => noda.deleteDocument('t', 'f'),
      () => noda.getHealth(),
      () => noda.uploadDocument({ tenant: 't', filename: 'f', bytes: new Uint8Array() }),
    ]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NodaError);
      expect((err as NodaError).code).toBe('missing_key');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('오류 글에 키가 없다', async () => {
    const f = (async () => json({ error: `서버 오류 (Bearer ${KEY})` }, 500)) as unknown as typeof fetch;
    const { noda } = client(f);
    const err = await noda.listDocuments('t').catch((e) => e);
    expect(err).toBeInstanceOf(NodaError);
    expect(err.status).toBe(500);
    expect(err.message).toMatch(/^NODA 500: /);
    expect(err.message).not.toContain(KEY);
    // 네트워크 오류 글에도 키가 없다
    const g = (async () => {
      throw new TypeError(`connect failed for ${KEY}`);
    }) as unknown as typeof fetch;
    const e2 = await client(g).noda.getHealth().catch((e) => e);
    expect(e2.message).not.toContain(KEY);
  });

  it('오류 글은 본문 앞 200자만', async () => {
    const f = (async () => new Response('x'.repeat(5000), { status: 400 })) as unknown as typeof fetch;
    const err = await client(f).noda.listDocuments('t').catch((e) => e);
    expect(err.message).toBe(`NODA 400: ${'x'.repeat(200)}`);
  });
});

describe('상수', () => {
  it('NODA_MIN_SIMILARITY는 실측 구간 0.80~0.82 안', () => {
    expect(NODA_MIN_SIMILARITY).toBeGreaterThanOrEqual(0.8);
    expect(NODA_MIN_SIMILARITY).toBeLessThanOrEqual(0.82);
  });
});
