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

import { uploadAttachment } from '@/lib/attachments/upload-client';

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const ROW = {
  id: 'a1',
  user_id: 'u1',
  conversation_id: null,
  file_name: '예산.xlsx',
  size_bytes: 1000,
  status: 'ready',
  summary: null,
  error: null,
  created_at: '2026-10-17T00:00:00Z',
};

function makeFile(name = '예산.xlsx', size = 1000) {
  return { name, size } as unknown as File;
}

describe('uploadAttachment', () => {
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

  it('발급 → 올리기 → 확인 순서로 단계를 알린다', async () => {
    const calls: string[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      calls.push(`fetch ${url}`);
      if (url === '/api/attachments/upload-url') {
        return jsonResponse({ ok: true, data: { id: 'a1', path: 'chat-uploads/o/a1', token: 'tok' } });
      }
      return jsonResponse({ ok: true, data: ROW });
    });
    uploadToSignedUrl.mockImplementation(async () => {
      calls.push('upload');
      return { data: {}, error: null };
    });

    const stages: string[] = [];
    const file = makeFile();
    const result = await uploadAttachment(file, (s) => stages.push(s));

    expect(result).toEqual({ ok: true, attachment: ROW });
    expect(stages).toEqual(['uploading', 'reading']);
    expect(calls).toEqual(['fetch /api/attachments/upload-url', 'upload', 'fetch /api/attachments']);
    expect(from).toHaveBeenCalledWith('docs-bucket');
    expect(uploadToSignedUrl).toHaveBeenCalledWith('chat-uploads/o/a1', 'tok', file);

    const issue = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(issue).toEqual({ file_name: '예산.xlsx', size: 1000 });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ id: 'a1' });
  });

  it('읽지 못한 파일(failed)도 성공 응답으로 돌려준다 — 칩에 이유를 보이기 위해서다', async () => {
    const failed = { ...ROW, status: 'failed', error: '암호가 걸린 파일입니다.' };
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/attachments/upload-url'
        ? jsonResponse({ ok: true, data: { id: 'a1', path: 'p', token: 't' } })
        : jsonResponse({ ok: true, data: failed })
    );
    uploadToSignedUrl.mockResolvedValue({ data: {}, error: null });

    const result = await uploadAttachment(makeFile(), () => {});
    expect(result).toEqual({ ok: true, attachment: failed });
  });

  it('발급이 거절되면 서버 메시지를 그대로 전하고 올리지 않는다', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: false, error: { message: '보내지 않은 첨부가 너무 많습니다.' } }, 429)
    );
    const stages: string[] = [];
    const result = await uploadAttachment(makeFile(), (s) => stages.push(s));

    expect(result).toEqual({ ok: false, message: '보내지 않은 첨부가 너무 많습니다.' });
    expect(uploadToSignedUrl).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('올리기가 실패하면 확인을 부르지 않는다', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/attachments/upload-url') {
        return jsonResponse({ ok: true, data: { id: 'a1', path: 'p', token: 't' } });
      }
      return jsonResponse({ ok: true, data: { id: 'a1' } }); // 정리용 DELETE
    });
    uploadToSignedUrl.mockResolvedValue({ data: null, error: { message: 'boom' } });

    const stages: string[] = [];
    const result = await uploadAttachment(makeFile(), (s) => stages.push(s));

    expect(result.ok).toBe(false);
    expect(stages).toEqual(['uploading']);
    // 확인(POST /api/attachments)은 없다. 슬롯을 비우는 DELETE만 간다
    const confirmCalls = fetchMock.mock.calls.filter(
      ([url, init]) => url === '/api/attachments' && init?.method === 'POST'
    );
    expect(confirmCalls).toHaveLength(0);
    expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/attachments/a1' && init?.method === 'DELETE')).toBe(true);
  });

  it('올리기 중 예외가 나도 메시지로 돌려준다', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/attachments/upload-url'
        ? jsonResponse({ ok: true, data: { id: 'a1', path: 'p', token: 't' } })
        : jsonResponse({ ok: true, data: {} })
    );
    uploadToSignedUrl.mockRejectedValue(new Error('network'));
    const result = await uploadAttachment(makeFile(), () => {});
    expect(result.ok).toBe(false);
  });

  it('확인이 거절되면 서버 메시지를 전한다', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/attachments/upload-url'
        ? jsonResponse({ ok: true, data: { id: 'a1', path: 'p', token: 't' } })
        : jsonResponse({ ok: false, error: { message: '확인 시간이 지났습니다. 다시 올려 주세요.' } }, 410)
    );
    uploadToSignedUrl.mockResolvedValue({ data: {}, error: null });

    const stages: string[] = [];
    const result = await uploadAttachment(makeFile(), (s) => stages.push(s));
    expect(result).toEqual({ ok: false, message: '확인 시간이 지났습니다. 다시 올려 주세요.' });
    expect(stages).toEqual(['uploading', 'reading']);
  });

  it('서버가 JSON이 아닌 응답을 주면 기본 메시지로 돌려준다', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response);
    const result = await uploadAttachment(makeFile(), () => {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
  });

  it('옛 형식·허용 밖 형식·큰 파일은 네트워크 전에 거른다', async () => {
    const xls = await uploadAttachment(makeFile('옛것.xls'), () => {});
    expect(xls.ok).toBe(false);
    if (!xls.ok) expect(xls.message).toContain('XLSX');

    const exe = await uploadAttachment(makeFile('a.exe'), () => {});
    expect(exe.ok).toBe(false);

    const big = await uploadAttachment(makeFile('a.pdf', 11 * 1024 * 1024), () => {});
    expect(big.ok).toBe(false);

    const empty = await uploadAttachment(makeFile('a.pdf', 0), () => {});
    expect(empty.ok).toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('공개 설정이 비어 있으면 주소 발급 전에 안내하고 멈춘다', async () => {
    for (const blank of ['url', 'anon'] as const) {
      cfg.url = 'https://example.supabase.co';
      cfg.anon = 'anon';
      cfg[blank] = '';
      const result = await uploadAttachment(makeFile(), () => {});
      expect(result).toEqual({ ok: false, message: '파일 올리기 설정이 없습니다. 관리자에게 문의하세요.' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(uploadToSignedUrl).not.toHaveBeenCalled();
  });
});
