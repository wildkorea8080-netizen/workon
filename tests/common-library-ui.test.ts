import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';

/**
 * 공통 자료실 운영자 화면(S5). 화면을 실행하는 장치가 없어 원본 글을 읽는다
 * (chat-documents-ui.test.ts와 같은 방식). 올리기 클라이언트는 실제로 돌려 순서를 본다.
 */
const PAGE = 'src/app/super/common-library/page.tsx';
const CLIENT = 'src/lib/common-upload-client.ts';

describe('공통 자료실 화면 원본', () => {
  const page = readFileSync(PAGE, 'utf8');

  it('메뉴에 기관 관리 다음으로 들어 있다', () => {
    const nav = readFileSync('src/components/super/SuperNav.tsx', 'utf8');
    expect(nav).toMatch(/href: '\/super\/common-library',\s*label: '공통 자료실',\s*icon: '📚'/);
    expect(nav.indexOf('/super/organizations')).toBeLessThan(nav.indexOf('/super/common-library'));
    expect(nav.indexOf('/super/common-library')).toBeLessThan(nav.indexOf('/super/accounts'));
  });

  it('목록 다시 부르기는 앞 응답 뒤에 다음을 예약하고, 늦은 옛 응답은 버린다', () => {
    expect(page).not.toContain('setInterval(');
    expect(page).toMatch(/await refreshDocuments\(\);\s*if \(!stopped\) timer = setTimeout\(tick, POLL_INTERVAL_MS\)/);
    expect(page).toContain('if (seq !== listSeqRef.current) return;');
    expect(page).toContain('POLL_INTERVAL_MS = 5_000');
    // 읽는 중이 있을 때만 돈다
    expect(page).toMatch(/const hasReading = [^;]*noda_status === 'reading'/);
    expect(page).toMatch(/if \(!hasReading\) return;/);
  });

  it("'다시 시도'와 지우기는 나가 있는 목록 응답을 버리게 순번을 올린다", () => {
    const retry = page.slice(page.indexOf('const handleRetry'), page.indexOf('const handleDelete'));
    expect(retry).toContain('listSeqRef.current++');
    const del = page.slice(page.indexOf('const handleDelete'), page.indexOf('const handleUpload'));
    expect(del).toContain('listSeqRef.current++');
  });

  it('kick 행은 그 id로 읽기를 한 번만 건다', () => {
    expect(page).toContain('row.kick');
    expect(page).toContain('kickedRef');
    expect(page).toMatch(/startCommonReading\(\[row\.id\]\)/);
  });

  it('이용 조건은 필수이고 서버가 거절하기 전에 화면이 먼저 막는다', () => {
    expect(page).toMatch(/!form\.usageTerms\.trim\(\)/);
    expect(page).toContain('이용 조건');
  });

  it('화면 문구', () => {
    expect(page).toContain('지난 판');
    expect(page).toContain('바꿀 옛 판');
    expect(page).toContain('없음(새 문서)');
    expect(page).toContain('읽지 못한 판은 지운 뒤 다시 올리세요 — 같은 이름의 판이 남아 있으면 새로 올릴 수 없습니다.');
    for (const label of ['읽는 중', '읽음', '읽기 실패', '읽을 수 없음', '지우는 중']) {
      expect(page).toContain(label);
    }
  });

  it('유형 탭은 ORG_TYPES를 그대로 쓰고 서버 설정을 가져오지 않는다', () => {
    expect(page).toContain("from '@/lib/org-types'");
    expect(page).not.toMatch(/from\s+['"]@\/lib\/config['"]/);
    expect(readFileSync(CLIENT, 'utf8')).not.toMatch(/from\s+['"]@\/lib\/config['"]/);
  });
});

describe('uploadCommonDocument', () => {
  const calls: string[] = [];
  const uploadToSignedUrl = vi.fn();

  beforeEach(() => {
    calls.length = 0;
    uploadToSignedUrl.mockReset();
    uploadToSignedUrl.mockImplementation(async () => {
      calls.push('storage');
      return { error: null };
    });
    vi.resetModules();
    vi.doMock('@/lib/config-public', () => ({
      PUBLIC_SUPABASE_URL: 'http://x',
      PUBLIC_SUPABASE_ANON_KEY: 'k',
      SUPABASE_DOCUMENTS_BUCKET: 'documents',
    }));
    vi.doMock('@/lib/browser-storage', () => ({
      storageClient: () => ({ storage: { from: () => ({ uploadToSignedUrl }) } }),
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('@/lib/config-public');
    vi.doUnmock('@/lib/browser-storage');
  });

  const meta = {
    org_type: '지방자치단체' as const,
    title: '예산편성기준',
    edition_year: 2026,
    usage_terms: '공공누리 1유형 확인',
  };
  const file = () => new File(['x'], '기준.pdf', { type: 'application/pdf' });

  function stubFetch(handler: (url: string, init: RequestInit) => { ok: boolean; status?: number; json: unknown }) {
    const fn = vi.fn(async (url: string, init: RequestInit) => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      const r = handler(url, init);
      return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 400), json: async () => r.json };
    });
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  it('발급 → 저장소 → 확인 순서로 부르고, 읽기는 keepalive로 건다', async () => {
    const fetchFn = stubFetch((url) => {
      if (url.endsWith('/upload-url')) return { ok: true, json: { ok: true, data: { path: 'p', token: 't' } } };
      if (url === '/api/super/common-documents') return { ok: true, json: { ok: true, data: { id: 'doc-1' } } };
      return { ok: true, json: { ok: true, data: {} } };
    });
    const { uploadCommonDocument } = await import('@/lib/common-upload-client');
    const stages: string[] = [];
    const result = await uploadCommonDocument(file(), { ...meta, replaces_id: 'old-1' }, (s) => stages.push(s));
    expect(result).toEqual({ ok: true, id: 'doc-1' });
    expect(stages).toEqual(['uploading', 'registering']);
    expect(calls.slice(0, 3)).toEqual([
      'POST /api/super/common-documents/upload-url',
      'storage',
      'POST /api/super/common-documents',
    ]);
    expect(uploadToSignedUrl).toHaveBeenCalledWith('p', 't', expect.any(File));
    const issueBody = JSON.parse(fetchFn.mock.calls[0][1].body as string);
    expect(issueBody).toMatchObject({ file_name: '기준.pdf', org_type: '지방자치단체', file_type: 'application/pdf' });
    const confirmBody = JSON.parse(fetchFn.mock.calls[1][1].body as string);
    expect(confirmBody).toMatchObject({
      storage_path: 'p',
      title: '예산편성기준',
      edition_year: 2026,
      usage_terms: '공공누리 1유형 확인',
      replaces_id: 'old-1',
    });
    const read = fetchFn.mock.calls.find((c) => String(c[0]).endsWith('/doc-1/read'))!;
    expect(read[1].method).toBe('POST');
    expect((read[1] as { keepalive?: boolean }).keepalive).toBe(true);
  });

  it('바꿀 옛 판이 없으면 replaces_id를 보내지 않는다', async () => {
    const fetchFn = stubFetch((url) =>
      url.endsWith('/upload-url')
        ? { ok: true, json: { ok: true, data: { path: 'p', token: 't' } } }
        : { ok: true, json: { ok: true, data: { id: 'd' } } }
    );
    const { uploadCommonDocument } = await import('@/lib/common-upload-client');
    await uploadCommonDocument(file(), meta);
    const confirmBody = JSON.parse(fetchFn.mock.calls[1][1].body as string);
    expect('replaces_id' in confirmBody).toBe(false);
  });

  it('확인 거절(409)의 서버 문구를 그대로 돌려주고 읽기를 걸지 않는다', async () => {
    const msg = "같은 이름의 문서가 이미 있습니다 — '바꿀 옛 판'으로 고르세요";
    const fetchFn = stubFetch((url) =>
      url.endsWith('/upload-url')
        ? { ok: true, json: { ok: true, data: { path: 'p', token: 't' } } }
        : { ok: false, status: 409, json: { ok: false, error: { message: msg } } }
    );
    const { uploadCommonDocument } = await import('@/lib/common-upload-client');
    const result = await uploadCommonDocument(file(), meta);
    expect(result).toEqual({ ok: false, message: msg });
    expect(fetchFn.mock.calls.some((c) => String(c[0]).endsWith('/read'))).toBe(false);
  });

  it('발급이 거절되면 저장소에 올리지 않는다', async () => {
    stubFetch(() => ({ ok: false, json: { ok: false, error: { message: '형식이 안 맞습니다' } } }));
    const { uploadCommonDocument } = await import('@/lib/common-upload-client');
    const result = await uploadCommonDocument(file(), meta);
    expect(result).toEqual({ ok: false, message: '형식이 안 맞습니다' });
    expect(uploadToSignedUrl).not.toHaveBeenCalled();
  });

  it('저장소에 올리지 못하면 확인하지 않는다', async () => {
    uploadToSignedUrl.mockResolvedValue({ error: new Error('boom') });
    const fetchFn = stubFetch(() => ({ ok: true, json: { ok: true, data: { path: 'p', token: 't' } } }));
    const { uploadCommonDocument } = await import('@/lib/common-upload-client');
    const result = await uploadCommonDocument(file(), meta);
    expect(result.ok).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('화면 검사: 빈 파일·허용되지 않는 형식은 서버에 가기 전에 막는다', async () => {
    const fetchFn = stubFetch(() => ({ ok: true, json: { ok: true, data: {} } }));
    const { uploadCommonDocument } = await import('@/lib/common-upload-client');
    const bad = await uploadCommonDocument(new File(['x'], 'a.exe'), meta);
    expect(bad.ok).toBe(false);
    const empty = await uploadCommonDocument(new File([], 'a.pdf'), meta);
    expect(empty).toEqual({ ok: false, message: '빈 파일입니다.' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('startCommonReading은 id마다 keepalive로 걸고 실패해도 나머지를 보낸다', async () => {
    const fn = vi.fn((url: string) => {
      if (url.includes('/a/')) throw new Error('keepalive 상한');
      return Promise.reject(new Error('net'));
    });
    vi.stubGlobal('fetch', fn);
    const { startCommonReading } = await import('@/lib/common-upload-client');
    startCommonReading(['a', 'b'], { retry: true });
    expect(fn).toHaveBeenCalledTimes(2);
    const [url, init] = fn.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe('/api/super/common-documents/b/read');
    expect(JSON.parse(init.body as string)).toEqual({ retry: true });
    expect((init as { keepalive?: boolean }).keepalive).toBe(true);
    await Promise.resolve();
  });
});
