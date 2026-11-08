import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';

/** 지난 파일 다시 붙이기(2026-11-05) — 내 것만, 새 첨부로 복사, 직접 올리기와 같은 발급·확인 길 */

const state = vi.hoisted(() => ({
  session: { user: { id: 'me' } } as unknown,
  results: {} as Record<string, { data?: unknown; error?: { message: string } | null }[]>,
  calls: [] as unknown[][],
  download: { ok: true, bytes: Buffer.from('a,b\n1,2\n'), type: 'text/csv' },
  uploadError: null as { message: string } | null,
  uploads: [] as unknown[][],
}));
const store = vi.hoisted(() => ({
  createUpload: vi.fn(async () => ({ ok: true as const, id: '22222222-0000-4000-8000-000000000001', path: 'chat-uploads/org/me/new.csv', token: 't' })),
  confirmUpload: vi.fn(async () => ({ ok: true as const, attachment: { id: '22222222-0000-4000-8000-000000000001', status: 'ready' } })),
  deleteAttachment: vi.fn(async () => true),
}));
vi.mock('@/lib/attachments/store', () => store);
vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => state.session }));
vi.mock('@/lib/actor-scope', () => ({ getActorScope: async () => ({ userId: 'me', departmentId: 'dept', organizationId: 'org' }) }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'not', 'gte', 'order', 'limit']) q[m] = (...args: unknown[]) => { state.calls.push([table, m, ...args]); return q; };
      const next = () => Promise.resolve({ data: null, error: null, ...(state.results[table]?.shift() ?? {}) });
      q.maybeSingle = () => next();
      q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => next().then(resolve, reject);
      return q;
    },
    storage: {
      from: () => ({
        download: async () => (state.download.ok ? { data: new Blob([state.download.bytes], { type: state.download.type }), error: null } : { data: null, error: { message: 'missing' } }),
        upload: async (...args: unknown[]) => { state.uploads.push(args); return { error: state.uploadError }; },
      }),
    },
  },
}));

import { reusableList, reuseFile, REUSE_LIST_MAX, listReusableFiles } from '@/lib/attachments/reuse';
import { GET as listRoute } from '@/app/api/attachments/reusable/route';
import { POST as reuseRoute } from '@/app/api/attachments/reuse/route';
import { NextRequest } from 'next/server';

const SRC = '11111111-0000-4000-8000-00000000000a';
const actor = { userId: 'me', departmentId: 'dept', organizationId: 'org' };

beforeEach(() => {
  state.session = { user: { id: 'me' } };
  state.results = {}; state.calls = []; state.uploads = []; state.uploadError = null;
  state.download = { ok: true, bytes: Buffer.from('a,b\n1,2\n'), type: 'text/csv' };
  store.createUpload.mockClear(); store.confirmUpload.mockClear(); store.deleteAttachment.mockClear();
});

describe('다시 붙일 수 있는 목록', () => {
  const f = (id: string, file_name: string, size_bytes: number, created_at: string, kind: 'attachment' | 'generated' = 'attachment') => ({ kind, id, file_name, size_bytes, created_at });
  it('첨부할 수 있는 형식·크기만, 같은 이름·크기는 새것 하나, 새것부터 20개', () => {
    const list = reusableList([
      f('a', '예산.xlsx', 100, '2026-11-01T00:00:00Z'),
      f('b', '예산.xlsx', 100, '2026-11-03T00:00:00Z', 'generated'),
      f('c', '사진.jpg', 100, '2026-11-04T00:00:00Z'),
      f('d', '빈.csv', 0, '2026-11-04T00:00:00Z'),
      f('e', '큰.pdf', 11 * 1024 * 1024, '2026-11-04T00:00:00Z'),
      f('g', '보고서.hwpx', 200, '2026-11-02T00:00:00Z', 'generated'),
    ]);
    expect(list.map((x) => x.id)).toEqual(['b', 'g']);
    expect(reusableList(Array.from({ length: 30 }, (_, i) => f(`x${i}`, `표${i}.csv`, 10, `2026-10-${String(i % 28 + 1).padStart(2, '0')}T00:00:00Z`)))).toHaveLength(REUSE_LIST_MAX);
  });

  it('조회는 요청자의 것만 — 읽힌·보낸 첨부와 만든 파일, 최근 90일', async () => {
    state.results.chat_attachments = [{ data: [{ id: 'a', file_name: '표.csv', size_bytes: 9, created_at: '2026-11-01T00:00:00Z' }] }];
    state.results.generated_files = [{ data: [{ id: 'g', file_name: '공문.hwpx', size_bytes: 50, created_at: '2026-11-02T00:00:00Z' }] }];
    const list = await listReusableFiles('me', Date.parse('2026-11-05T00:00:00Z'));
    expect(list.map((x) => [x.kind, x.id])).toEqual([['generated', 'g'], ['attachment', 'a']]);
    expect(state.calls).toContainEqual(['chat_attachments', 'eq', 'user_id', 'me']);
    expect(state.calls).toContainEqual(['chat_attachments', 'eq', 'status', 'ready']);
    expect(state.calls).toContainEqual(['chat_attachments', 'not', 'conversation_id', 'is', null]);
    expect(state.calls).toContainEqual(['generated_files', 'eq', 'user_id', 'me']);
    expect(state.calls).toContainEqual(['generated_files', 'gte', 'created_at', '2026-08-07T00:00:00.000Z']);
  });
});

describe('다시 붙이기', () => {
  it('내 원본을 새 첨부 자리에 복사하고 직접 올리기와 같은 확인을 탄다', async () => {
    state.results.chat_attachments = [{ data: { storage_path: 'chat-uploads/org/me/old.csv', file_name: '표.csv', status: 'ready' } }];
    const r = await reuseFile(actor, 'attachment', SRC.toUpperCase());
    expect(r).toMatchObject({ ok: true, attachment: { status: 'ready' } });
    expect(state.calls).toContainEqual(['chat_attachments', 'eq', 'id', SRC]);
    expect(state.calls).toContainEqual(['chat_attachments', 'eq', 'user_id', 'me']);
    expect(store.createUpload).toHaveBeenCalledWith(actor, { fileName: '표.csv', size: 8 });
    expect(state.uploads[0][0]).toBe('chat-uploads/org/me/new.csv');
    expect((state.uploads[0][1] as Buffer).toString()).toBe('a,b\n1,2\n');
    expect(state.uploads[0][2]).toMatchObject({ upsert: false });
    expect(store.confirmUpload).toHaveBeenCalledWith(actor, '22222222-0000-4000-8000-000000000001');
  });

  it('만든 파일도 내 것만', async () => {
    state.results.generated_files = [{ data: { storage_path: 'generated/org/c/x.hwpx', file_name: '공문.hwpx' } }];
    expect((await reuseFile(actor, 'generated', SRC)).ok).toBe(true);
    expect(state.calls).toContainEqual(['generated_files', 'eq', 'user_id', 'me']);
  });

  it('거절: 모르는 종류·이상한 id·남의 것/없는 것 404, 조회 실패 503, 원본이 없으면 404 — 모두 새 첨부를 만들지 않음', async () => {
    expect(await reuseFile(actor, 'document', SRC)).toMatchObject({ ok: false, status: 404 });
    expect(await reuseFile(actor, 'attachment', '../x')).toMatchObject({ ok: false, status: 404 });
    expect(await reuseFile(actor, 'attachment', SRC)).toMatchObject({ ok: false, status: 404 });
    state.results.chat_attachments = [{ error: { message: 'down' } }];
    expect(await reuseFile(actor, 'attachment', SRC)).toMatchObject({ ok: false, status: 503 });
    state.results.chat_attachments = [{ data: { storage_path: 'p', file_name: '표.csv', status: 'ready' } }];
    state.download.ok = false;
    expect(await reuseFile(actor, 'attachment', SRC)).toMatchObject({ ok: false, status: 404 });
    expect(store.createUpload).not.toHaveBeenCalled();
  });

  it('발급이 거절되면 그대로(보내지 않은 첨부 상한 등), 올리기가 실패하면 묘비로 남기고 500', async () => {
    state.results.chat_attachments = [{ data: { storage_path: 'p', file_name: '표.csv', status: 'ready' } }, { data: { storage_path: 'p', file_name: '표.csv', status: 'ready' } }];
    store.createUpload.mockResolvedValueOnce({ ok: false, status: 429, message: '보내지 않은 첨부가 너무 많습니다.' } as never);
    expect(await reuseFile(actor, 'attachment', SRC)).toMatchObject({ ok: false, status: 429 });
    state.uploadError = { message: 'full' };
    expect(await reuseFile(actor, 'attachment', SRC)).toMatchObject({ ok: false, status: 500 });
    expect(store.deleteAttachment).toHaveBeenCalledWith('me', '22222222-0000-4000-8000-000000000001');
    expect(store.confirmUpload).not.toHaveBeenCalled();
  });
});

describe('라우트·화면', () => {
  it('로그인 없으면 401', async () => {
    state.session = null;
    expect((await listRoute()).status).toBe(401);
    expect((await reuseRoute(new NextRequest('http://localhost/api/attachments/reuse', { method: 'POST', body: '{}' }))).status).toBe(401);
  });

  it('목록 조회 실패는 503, 다시 붙이기 결과는 첨부 꼴 그대로', async () => {
    state.results.chat_attachments = [{ error: { message: 'down' } }];
    expect((await listRoute()).status).toBe(503);
    state.results.chat_attachments = [{ data: { storage_path: 'p', file_name: '표.csv', status: 'ready' } }];
    const res = await reuseRoute(new NextRequest('http://localhost/api/attachments/reuse', { method: 'POST', body: JSON.stringify({ kind: 'attachment', id: SRC }) }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe('ready');
  });

  it('대화 입력에 지난 파일 단추(파일 받는 비서만), 화면은 서버 모듈을 가져오지 않는다', () => {
    const chat = readFileSync('src/components/chat/ChatInterface.tsx', 'utf8');
    expect(chat).toContain('{canAttachFiles && <ReusableFilePicker disabled={isLoading} onPick={fileAttach.addReused} />}');
    // 입력형 앱 실행 화면도 같은 고르기·같은 다시 붙이기 길(2026-11-08) — 앱 첨부 상한(APP_MAX_FILES)은 훅이 센다
    const run = readFileSync('src/app/apps/run/page.tsx', 'utf8');
    expect(run).toContain('<ReusableFilePicker placement="down"');
    expect(run).toContain('onPick={files.addReused}');
    expect(run).toContain('useFileAttachments(Boolean(definition?.attachments), APP_MAX_FILES)');
    const picker = readFileSync('src/components/chat/ReusableFilePicker.tsx', 'utf8');
    expect(picker).toContain("placement === 'down' ? 'top-10' : 'bottom-10'");
    expect(picker).toContain("from '@/lib/attachments/reuse-types'");
    expect(picker).not.toMatch(/attachments\/reuse'/);
    expect(readFileSync('src/components/chat/useFileAttachments.ts', 'utf8')).toContain("'/api/attachments/reuse'");
  });
});
