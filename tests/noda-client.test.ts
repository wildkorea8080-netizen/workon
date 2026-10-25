import { describe, expect, it, vi } from 'vitest';
import {
  NODA_CONTEXT_BUDGET,
  CONTEXT_BUDGET_AGENT_SHARED,
  CONTEXT_BUDGET_COMMON_SHARED,
  NODA_MIN_SIMILARITY,
  NodaError,
  PARSE_RETRY_WINDOW_MS,
  PARSE_TIMEOUT_MS,
  VERIFY_TIMEOUT_MS,
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

  it('getContext는 budget을 주면 그 값을, 없으면 4000을 싣는다', async () => {
    const bodies: Record<string, unknown>[] = [];
    const f = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return json({ context: '', sources: [], dropped: 0 });
    }) as unknown as typeof fetch;
    const { noda } = client(f);
    await noda.getContext({ tenant: 't', query: 'q', budget: 3000 });
    await noda.getContext({ tenant: 't', query: 'q' });
    expect(bodies[0].budget).toBe(3000);
    expect(bodies[1].budget).toBe(4000);
    expect(CONTEXT_BUDGET_AGENT_SHARED).toBe(3000);
    expect(CONTEXT_BUDGET_COMMON_SHARED).toBe(2000);
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

  it('deleteTenant는 보관함 이름을 confirm으로 한 번 더 보내고, 지운 수가 있으면 돌려준다', async () => {
    const calls: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`);
      return json({ deleted: 3 });
    }) as unknown as typeof fetch;
    const { noda } = client(f);
    const tenant = nodaTenant(ID);
    expect(await noda.deleteTenant(tenant)).toEqual({ existed: true, deleted: 3 });
    expect(calls).toHaveLength(1);
    expect(calls[0].startsWith('DELETE ')).toBe(true);
    const u = new URL(calls[0].split(' ')[1]);
    expect(u.pathname).toBe('/documents');
    expect(u.searchParams.get('tenant')).toBe(tenant);
    expect(u.searchParams.get('all')).toBe('1');
    expect(u.searchParams.get('confirm')).toBe(tenant);
    expect(u.searchParams.get('filename')).toBeNull();
  });

  it('deleteTenant 404는 existed:false, 본문에 수가 없으면 deleted:null', async () => {
    const a = client((async () => json({ error: 'not found' }, 404)) as unknown as typeof fetch);
    expect(await a.noda.deleteTenant('t')).toEqual({ existed: false, deleted: null });
    const b = client((async () => json({ ok: true })) as unknown as typeof fetch);
    expect(await b.noda.deleteTenant('t')).toEqual({ existed: true, deleted: null });
  });

  it('deleteTenant는 503이면 다시 시도하고 401은 던진다', async () => {
    let n = 0;
    const f = (async () => (++n === 1 ? json({}, 503) : json({ deleted: 1 }))) as unknown as typeof fetch;
    const { noda } = client(f);
    expect(await noda.deleteTenant('t')).toEqual({ existed: true, deleted: 1 });
    expect(n).toBe(2);
    const bad = client((async () => json({}, 401)) as unknown as typeof fetch);
    await expect(bad.noda.deleteTenant('t')).rejects.toBeInstanceOf(NodaError);
  });

  it('listDocuments는 receiving이 없어도 빈 배열', async () => {
    const { noda } = client((async () => json({ documents: [{ filename: 'a', doc_id: 'd', extra: 1 }] })) as unknown as typeof fetch);
    const r = await noda.listDocuments('t');
    expect(r.documents).toEqual([{ filename: 'a', doc_id: 'd' }]);
    expect(r.receiving).toEqual([]);
    const { noda: n2 } = client((async () => json({})) as unknown as typeof fetch);
    expect(await n2.listDocuments('t')).toEqual({ documents: [], receiving: [], failed: [] });
  });

  it('listDocuments는 문서의 readable·reason과 failed(비동기 넣기 실패)를 읽는다', async () => {
    const { noda } = client((async () =>
      json({
        documents: [
          { filename: 'a', doc_id: 'd', readable: true },
          { filename: 'b', readable: false, reason: 'PASSWORD_PROTECTED' },
        ],
        failed: [{ filename: 'c', status: 403, error: '한도를 넘습니다', at: '2026-10-24T08:40:00+00:00' }, null, 'x'],
      })) as unknown as typeof fetch);
    const r = await noda.listDocuments('t');
    expect(r.documents).toEqual([
      { filename: 'a', doc_id: 'd', readable: true, reason: null },
      { filename: 'b', readable: false, reason: 'PASSWORD_PROTECTED' },
    ]);
    expect(r.failed).toEqual([{ filename: 'c', status: 403, error: '한도를 넘습니다', at: '2026-10-24T08:40:00+00:00' }]);
  });

  it('비동기 넣기는 async=1을 붙이고, 202면 accepted로 끝난다', async () => {
    const urls: string[] = [];
    const f = (async (url: string) => {
      urls.push(url);
      return json({ tenant: 't', filename: 'f.pdf', bytes: 3, accepted: true, receiving: true }, 202);
    }) as unknown as typeof fetch;
    const r = await client(f).noda.uploadDocument({ tenant: 't', filename: 'f.pdf', bytes: new Uint8Array([1, 2, 3]), async: true });
    expect(urls[0]).toContain('async=1');
    expect(urls[0]).toContain('replace=1');
    expect(r.accepted).toBe(true);
    expect(r.readable).toBe(false);
  });

  it('비동기를 모르는 서버가 201로 결과를 주면 지금처럼 결과를 돌려준다', async () => {
    const f = (async () => json({ stored: true, readable: true, doc_id: 'd', chunks: 2 }, 201)) as unknown as typeof fetch;
    const r = await client(f).noda.uploadDocument({ tenant: 't', filename: 'f.pdf', bytes: new Uint8Array([1]), async: true });
    expect(r.accepted).toBe(false);
    expect(r.readable).toBe(true);
    expect(r.doc_id).toBe('d');
  });

  it('웹훅 걸기·핑·목록·떼기는 키로 부른다', async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), body: init.body as string | undefined });
      if (url.includes('/webhooks/ping')) return json({ ok: true, status: 200, ms: 12 });
      if (init.method === 'POST') return json({ id: 'wh_1', url: 'https://x/hook', events: [], secret: 'whsec_s' }, 201);
      if (init.method === 'DELETE') return json({ deleted: true });
      return json({ webhooks: [{ id: 'wh_1', url: 'https://x/hook' }] });
    }) as unknown as typeof fetch;
    const { noda } = client(f);
    expect(await noda.createWebhook('https://x/hook')).toMatchObject({ id: 'wh_1', secret: 'whsec_s' });
    expect(JSON.parse(calls[0].body!)).toEqual({ url: 'https://x/hook' });
    expect(await noda.pingWebhook('wh_1')).toMatchObject({ ok: true });
    expect(JSON.parse(calls[1].body!)).toEqual({ id: 'wh_1' });
    expect((await noda.listWebhooks()).length).toBe(1);
    await noda.deleteWebhook('wh_1');
    expect(calls[3].url).toContain('id=wh_1');
    expect(calls[3].method).toBe('DELETE');
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

  it('시도 한 번의 시간 제한: /context 8초, 그 밖 30초, 업로드 300초', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const f = (async () => {
      throw timeout;
    }) as unknown as typeof fetch;
    const { noda } = client(f);
    expect((await noda.getContext({ tenant: 't', query: 'q' }).catch((e) => e)).message).toContain('(8초)');
    expect((await noda.listDocuments('t').catch((e) => e)).message).toContain('(30초)');
    expect((await noda.deleteDocument('t', 'f').catch((e) => e)).message).toContain('(30초)');
    expect(
      (await noda.uploadDocument({ tenant: 't', filename: 'f', bytes: new Uint8Array() }).catch((e) => e)).message,
    ).toContain('(300초)');
  });

  it('listDocuments(retry:false)는 한 번만 부르고, timeoutMs를 따른다', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ error: 'busy' }, 503));
    const { noda, clock } = client(fetchMock as unknown as typeof fetch);
    const err = await noda.listDocuments('t', { retry: false }).catch((e) => e);
    expect(err).toBeInstanceOf(NodaError);
    expect(err.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]);

    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const g = (async () => {
      throw timeout;
    }) as unknown as typeof fetch;
    const e2 = await client(g).noda.listDocuments('t', { retry: false, timeoutMs: 4_000 }).catch((e) => e);
    expect(e2.message).toContain('(4초)');
  });

  it('Retry-After: 0이어도 1초는 기다린다(서버를 몰아치지 않게)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({}, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(json({ documents: [] }));
    const { noda, clock } = client(fetchMock as unknown as typeof fetch);
    await noda.listDocuments('t');
    expect(clock.sleeps).toEqual([1000]);
  });

  it('오류 글은 본문 앞 200자만', async () => {
    const f = (async () => new Response('x'.repeat(5000), { status: 400 })) as unknown as typeof fetch;
    const err = await client(f).noda.listDocuments('t').catch((e) => e);
    expect(err.message).toBe(`NODA 400: ${'x'.repeat(200)}`);
  });
});

describe('답변 검증(/verify)·문서 읽기(/parse)', () => {
  it('verifyAnswer는 tenant·answer·sources(doc_id·chunk_id만, 순서 그대로)를 보내고 5초 제한, 다시 시도하지 않는다', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return json({ grounded: false, unsupported_numbers: ['1,234'], unknown_refs: [3] });
    });
    const { noda } = client(fetchMock as unknown as typeof fetch);
    const r = await noda.verifyAnswer({
      tenant: 'workon-a1',
      answer: '합계는 1,234입니다 [1][3]',
      sources: [
        { doc_id: 'd2', chunk_id: 'c9', extra: 'x' } as { doc_id: string; chunk_id: string },
        { doc_id: 'd1', chunk_id: 'c1' },
      ],
    });
    expect(r).toEqual({ grounded: false, unsupported_numbers: ['1,234'], unknown_refs: [3] });
    expect(calls[0].url).toBe('https://noda.test/verify');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      tenant: 'workon-a1',
      answer: '합계는 1,234입니다 [1][3]',
      sources: [
        { doc_id: 'd2', chunk_id: 'c9' },
        { doc_id: 'd1', chunk_id: 'c1' },
      ],
    });
    expect(VERIFY_TIMEOUT_MS).toBe(5_000);

    const f503 = vi.fn(async () => json({ error: 'busy' }, 503, { 'retry-after': '1' }));
    const c = client(f503 as unknown as typeof fetch);
    const err = await c.noda.verifyAnswer({ tenant: 't', answer: 'a', sources: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(NodaError);
    expect(err.status).toBe(503);
    expect(f503).toHaveBeenCalledTimes(1);
    expect(c.clock.sleeps).toEqual([]);
  });

  it('verifyAnswer는 시간 제한 5초 문구, 네트워크 오류도 한 번뿐', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const { noda } = client(
      (async () => {
        throw timeout;
      }) as unknown as typeof fetch,
    );
    const err = await noda.verifyAnswer({ tenant: 't', answer: 'a', sources: [] }).catch((e) => e);
    expect(err.code).toBe('timeout');
    expect(err.message).toContain('(5초)');
    const net = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const e2 = await client(net as unknown as typeof fetch)
      .noda.verifyAnswer({ tenant: 't', answer: 'a', sources: [] })
      .catch((e) => e);
    expect(e2.code).toBe('network');
    expect(net).toHaveBeenCalledTimes(1);
  });

  it('verifyAnswer 응답의 빠진 칸은 기본값', async () => {
    const { noda } = client((async () => json({})) as unknown as typeof fetch);
    expect(await noda.verifyAnswer({ tenant: 't', answer: 'a', sources: [] })).toEqual({
      grounded: false,
      unsupported_numbers: [],
      unknown_refs: [],
    });
    const { noda: n2 } = client(
      (async () => json({ grounded: 'yes', unsupported_numbers: 'x', unknown_refs: null })) as unknown as typeof fetch,
    );
    expect(await n2.verifyAnswer({ tenant: 't', answer: 'a', sources: [] })).toEqual({
      grounded: false,
      unsupported_numbers: [],
      unknown_refs: [],
    });
  });

  it('parseDocument는 X-Filename 인코딩·바이트 본문, 503은 Retry-After 따라 다시', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let n = 0;
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      n += 1;
      if (n === 1) return json({ error: 'busy' }, 503, { 'retry-after': '5' });
      return json({ access: { readable: true }, source: { pages: 2 }, blocks: [], tables: [] });
    });
    const { noda, clock } = client(fetchMock as unknown as typeof fetch);
    const bytes = new Uint8Array([1, 2, 3]);
    const r = await noda.parseDocument({ filename: '스캔 문서.pdf', bytes });
    expect(r.readable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(clock.sleeps).toEqual([5000]);
    expect(calls[0].url).toBe('https://noda.test/parse');
    expect(calls[0].init.method).toBe('POST');
    const h = calls[0].init.headers as Record<string, string>;
    expect(h['X-Filename']).toBe(encodeURIComponent('스캔 문서.pdf'));
    expect(h['Content-Type']).toBe('application/octet-stream');
    expect(h.Authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].init.body).toBe(bytes);
    expect(PARSE_TIMEOUT_MS).toBe(60_000);
    expect(PARSE_RETRY_WINDOW_MS).toBe(30_000);
  });

  it('parseDocument는 Retry-After가 30초 창을 넘기면 기다리지 않고, 시간 제한은 60초·다시 안 함', async () => {
    const f = vi.fn(async () => json({}, 503, { 'retry-after': '40' }));
    const c = client(f as unknown as typeof fetch);
    const err = await c.noda.parseDocument({ filename: 'a.pdf', bytes: new Uint8Array() }).catch((e) => e);
    expect(err.status).toBe(503);
    expect(f).toHaveBeenCalledTimes(1);
    expect(c.clock.sleeps).toEqual([]);

    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const t = vi.fn().mockRejectedValue(timeout);
    const c2 = client(t as unknown as typeof fetch);
    const e2 = await c2.noda.parseDocument({ filename: 'a.pdf', bytes: new Uint8Array() }).catch((e) => e);
    expect(e2.code).toBe('timeout');
    expect(e2.message).toContain('(60초)');
    expect(t).toHaveBeenCalledTimes(1);
  });

  it('parseDocument는 access·source·blocks·tables를 정리한다', async () => {
    const { noda } = client(
      (async () =>
        json({
          access: { readable: false, reason: 'PASSWORD_PROTECTED' },
          source: {},
        })) as unknown as typeof fetch,
    );
    expect(await noda.parseDocument({ filename: 'a.pdf', bytes: new Uint8Array() })).toEqual({
      readable: false,
      reason: 'PASSWORD_PROTECTED',
      pages: 0,
      blocks: [],
      tables: [],
    });

    const { noda: n2 } = client(
      (async () =>
        json({
          access: { readable: true, reason: null },
          source: { pages: 3 },
          blocks: [{ id: 'b1', type: 'paragraph', text: '안녕', page: 1, bbox: [1, 2] }, 'x', null],
          tables: [
            {
              id: 't1',
              n_rows: 2,
              n_cols: 2,
              caption: '(단위: 천원)',
              cells: [
                { r: 0, c: 0, text: '구분' },
                { r: 0, c: 1, colspan: 2, text: null },
                { r: 1.5, c: 0, text: 'bad' },
                'x',
                { r: 1, c: 0, rowspan: 2, text: '100' },
              ],
            },
            'x',
          ],
        })) as unknown as typeof fetch,
    );
    const r = await n2.parseDocument({ filename: 'a.pdf', bytes: new Uint8Array() });
    expect(r.readable).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.pages).toBe(3);
    expect(r.blocks).toEqual([{ type: 'paragraph', text: '안녕', page: 1 }]);
    expect(r.tables).toEqual([
      {
        id: 't1',
        n_rows: 2,
        n_cols: 2,
        caption: '(단위: 천원)',
        cells: [
          { r: 0, c: 0, text: '구분' },
          { r: 0, c: 1, colspan: 2, text: null },
          { r: 1, c: 0, rowspan: 2, text: '100' },
        ],
      },
    ]);
  });

  it('parseDocument·verifyAnswer는 키가 비면 fetch 없이 missing_key', async () => {
    const f = vi.fn();
    const { noda } = client(f as unknown as typeof fetch, fakeClock(), '');
    expect((await noda.parseDocument({ filename: 'a', bytes: new Uint8Array() }).catch((e) => e)).code).toBe(
      'missing_key',
    );
    expect((await noda.verifyAnswer({ tenant: 't', answer: 'a', sources: [] }).catch((e) => e)).code).toBe(
      'missing_key',
    );
    expect(f).not.toHaveBeenCalled();
  });
});

describe('상수', () => {
  it('NODA_MIN_SIMILARITY는 실측 구간 0.80~0.82 안', () => {
    expect(NODA_MIN_SIMILARITY).toBeGreaterThanOrEqual(0.8);
    expect(NODA_MIN_SIMILARITY).toBeLessThanOrEqual(0.82);
  });
});
