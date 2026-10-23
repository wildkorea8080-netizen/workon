import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const uploadToSignedUrl = vi.fn();
const from = vi.fn(() => ({ uploadToSignedUrl }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ storage: { from } }),
}));
const cfg = vi.hoisted(() => ({ url: 'https://example.supabase.co', anon: 'anon' }));
vi.mock('@/lib/config-public', () => ({
  get PUBLIC_SUPABASE_URL() { return cfg.url; },
  get PUBLIC_SUPABASE_ANON_KEY() { return cfg.anon; },
  SUPABASE_DOCUMENTS_BUCKET: 'docs-bucket',
}));

import { uploadReferenceDocument, startReading } from '@/lib/document-upload-client';
import { MAX_UPLOAD_BYTES } from '@/lib/file-types';

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function makeFile(name = '2026 예산(최종).CSV', size = 1000, type = 'text/csv') {
  return { name, size, type } as unknown as File;
}

describe('uploadReferenceDocument', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    cfg.url = 'https://example.supabase.co';
    cfg.anon = 'anon';
    uploadToSignedUrl.mockReset();
    from.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('발급 → 저장소 직접 → 확인 순서, 확인한 문서 id를 돌려준다', async () => {
    const calls: string[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      calls.push(`fetch ${url}`);
      if (url === '/api/documents/upload-url') {
        return jsonResponse({ ok: true, data: { path: 'documents/d/u/1-x.csv', token: 'tok' } });
      }
      return jsonResponse({ ok: true, data: { documentIds: ['d1', 'd2'] } }, 201);
    });
    uploadToSignedUrl.mockImplementation(async () => {
      calls.push('upload');
      return { data: {}, error: null };
    });

    const stages: string[] = [];
    const file = makeFile();
    const result = await uploadReferenceDocument(
      file,
      { agentIds: ['a1', 'a2'], title: '예산', visibility: 'department' },
      (s) => stages.push(s)
    );

    expect(result).toEqual({ ok: true, documentIds: ['d1', 'd2'] });
    expect(stages).toEqual(['uploading', 'registering']);
    expect(calls).toEqual(['fetch /api/documents/upload-url', 'upload', 'fetch /api/documents/confirm']);
    expect(from).toHaveBeenCalledWith('docs-bucket');
    expect(uploadToSignedUrl).toHaveBeenCalledWith('documents/d/u/1-x.csv', 'tok', file);

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      file_name: '2026 예산(최종).CSV',
      size: 1000,
      file_type: 'text/csv',
      agent_ids: ['a1', 'a2'],
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      storage_path: 'documents/d/u/1-x.csv',
      file_name: '2026 예산(최종).CSV',
      file_type: 'text/csv',
      title: '예산',
      visibility: 'department',
      agent_ids: ['a1', 'a2'],
    });
  });

  it('발급 거절 문구를 그대로 돌려준다', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: false, error: { message: '비서에 붙일 수 있는 문서는 50개까지입니다.' } }, 400)
    );
    const stages: string[] = [];
    const result = await uploadReferenceDocument(makeFile(), { agentIds: ['a1'] }, (s) => stages.push(s));

    expect(result).toEqual({ ok: false, message: '비서에 붙일 수 있는 문서는 50개까지입니다.' });
    expect(uploadToSignedUrl).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('저장소 올리기가 실패하면 확인을 부르지 않는다', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ ok: true, data: { path: 'p', token: 't' } })
    );
    uploadToSignedUrl.mockResolvedValue({ data: null, error: { message: 'boom' } });

    const stages: string[] = [];
    const result = await uploadReferenceDocument(makeFile(), { agentIds: ['a1'] }, (s) => stages.push(s));

    expect(result.ok).toBe(false);
    expect(stages).toEqual(['uploading']);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 발급만. 확인은 없다
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/documents/confirm')).toBe(false);
  });

  it('저장소 올리기 중 예외가 나도 메시지로 돌려준다', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true, data: { path: 'p', token: 't' } }));
    uploadToSignedUrl.mockRejectedValue(new Error('network'));
    const result = await uploadReferenceDocument(makeFile(), { agentIds: ['a1'] });
    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('확인이 거절되면 서버 메시지를 전한다', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/documents/upload-url'
        ? jsonResponse({ ok: true, data: { path: 'p', token: 't' } })
        : jsonResponse({ ok: false, error: { message: '업로드 후 확인 시간이 지났습니다. 다시 올려 주세요.' } }, 410)
    );
    uploadToSignedUrl.mockResolvedValue({ data: {}, error: null });

    const result = await uploadReferenceDocument(makeFile(), { agentIds: ['a1'] });
    expect(result).toEqual({ ok: false, message: '업로드 후 확인 시간이 지났습니다. 다시 올려 주세요.' });
  });

  it('제목·공개 범위를 안 주면 확인 본문에 싣지 않는다', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/documents/upload-url'
        ? jsonResponse({ ok: true, data: { path: 'p', token: 't' } })
        : jsonResponse({ ok: true, data: { documentIds: ['d1'] } }, 201)
    );
    uploadToSignedUrl.mockResolvedValue({ data: {}, error: null });
    await uploadReferenceDocument(makeFile(), { agentIds: ['a1'] });
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body).not.toHaveProperty('title');
    expect(body).not.toHaveProperty('visibility');
  });

  it('화면 검사: 20MB 초과·빈 파일·허용 밖 형식은 발급 전에 거절', async () => {
    const big = await uploadReferenceDocument(makeFile('a.pdf', MAX_UPLOAD_BYTES + 1, 'application/pdf'), { agentIds: ['a1'] });
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.message).toContain('20MB');

    const empty = await uploadReferenceDocument(makeFile('a.pdf', 0), { agentIds: ['a1'] });
    expect(empty.ok).toBe(false);

    const exe = await uploadReferenceDocument(makeFile('a.exe', 10), { agentIds: ['a1'] });
    expect(exe.ok).toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('공개 설정이 비어 있으면 주소 발급 전에 안내하고 멈춘다', async () => {
    cfg.anon = '';
    const result = await uploadReferenceDocument(makeFile(), { agentIds: ['a1'] });
    expect(result).toEqual({ ok: false, message: '파일 올리기 설정이 없습니다. 관리자에게 문의하세요.' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('startReading', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keepalive로 문서마다 읽기 라우트를 한꺼번에 부른다 — 앞 읽기가 끝나기를 기다리지 않는다', async () => {
    const order: string[] = [];
    // 어느 호출도 끝나지 않는다 — 화면을 떠나 앞 요청이 끊겨도 뒤 문서의 읽기가 이미 나가 있어야 한다
    fetchMock.mockImplementation((url: string) => {
      order.push(url);
      return new Promise(() => {});
    });

    startReading(['d1', 'd2', 'd3']);
    expect(order).toEqual(['/api/documents/d1/read', '/api/documents/d2/read', '/api/documents/d3/read']);

    for (const [, init] of fetchMock.mock.calls) {
      expect(init.method).toBe('POST');
      expect(init.keepalive).toBe(true);
      expect(JSON.parse(init.body)).toEqual({});
    }
  });

  it('retry를 주면 본문에 싣는다', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, data: { status: 'reading' } }));
    startReading(['d1'], { retry: true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ retry: true });
  });

  it('호출이 실패해도 던지지 않고 다음 문서를 이어 부른다', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network')).mockResolvedValue(jsonResponse({ ok: true, data: {} }));
    expect(() => startReading(['d1', 'd2'])).not.toThrow();
    // fetch가 곧바로 던져도(keepalive 본문 상한 등) 나머지는 나간다
    fetchMock.mockReset();
    fetchMock.mockImplementationOnce(() => { throw new TypeError('keepalive quota'); }).mockResolvedValue(jsonResponse({ ok: true, data: {} }));
    expect(() => startReading(['x1', 'x2'])).not.toThrow();
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/documents/x1/read', '/api/documents/x2/read']);
    fetchMock.mockReset();
    fetchMock.mockRejectedValueOnce(new Error('network')).mockResolvedValue(jsonResponse({ ok: true, data: {} }));
    startReading(['d1', 'd2']);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toBe('/api/documents/d2/read');
  });

  it('문서가 없으면 아무것도 부르지 않는다', () => {
    startReading([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
