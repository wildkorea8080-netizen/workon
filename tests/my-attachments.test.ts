import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';

/** 결과물 화면의 '대화에 올린 파일'과 내 파일 통합 찾기(2026-11-08) — 내 것만, 대화에 보낸 읽힌 첨부만, 저장소 경로 없이 */

const state = {
  session: { user: { id: 'u-me' } } as { user: { id: string } } | null,
  rows: [] as Array<Record<string, unknown>>,
  single: null as Record<string, unknown> | null,
  calls: [] as Array<[string, ...unknown[]]>,
  error: null as { message: string } | null,
  signed: 'https://storage/x?token=1' as string | null,
};
vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => state.session }));
vi.mock('@/lib/supabaseAdmin', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'or', 'ilike', 'not']) chain[m] = (...args: unknown[]) => { state.calls.push([m, ...args]); return chain; };
  chain.maybeSingle = async () => ({ data: state.single, error: state.error });
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: state.rows, error: state.error }).then(resolve);
  return { supabaseAdmin: { from: (table: string) => { state.calls.push(['from', table]); return chain; } } };
});
vi.mock('@/lib/generated-files', () => ({
  signedDownloadUrl: async (path: string, name: string) => { state.calls.push(['sign', path, name]); return state.signed; },
}));

import { GET as LIST } from '@/app/api/attachments/mine/route';
import { GET as ORIGINAL } from '@/app/api/attachments/[id]/original/route';
import { MY_FILES_PAGE, parseCursor } from '@/lib/my-generated-files';
import { ATTACHMENT_SOURCE_LABEL } from '@/lib/my-attachments';
import { matchesFileQuery, normalizeFileQuery } from '@/lib/file-search';
import * as generated from '@/lib/my-generated-files';

const ID = '11111111-2222-4333-8444-555555555555';
const row = (i: number) => ({
  id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`, file_name: `예산 ${i}.xlsx`, size_bytes: 2000 + i, created_at: `2026-11-0${(i % 9) + 1}T00:00:00.000Z`,
  conversation_id: `c-${i}`, conversation: { title: `대화 ${i}` }, storage_path: `chat-uploads/o/u/${i}.xlsx`,
});
const list = (q = '') => LIST(new Request(`http://x/api/attachments/mine${q}`) as never);
const original = (id: string) => ORIGINAL(new Request(`http://x/api/attachments/${id}/original`) as never, { params: { id } });

beforeEach(() => {
  state.session = { user: { id: 'u-me' } }; state.rows = []; state.single = null; state.calls = []; state.error = null; state.signed = 'https://storage/x?token=1';
});

describe('대화에 올린 파일 목록', () => {
  it('로그인해야 한다', async () => {
    state.session = null;
    expect((await list()).status).toBe(401);
    expect(state.calls).toEqual([]);
  });
  it('요청자의 대화에 보낸 읽힌 첨부만, 최근 것부터 50개, 저장소 경로 없음', async () => {
    state.rows = Array.from({ length: MY_FILES_PAGE + 1 }, (_, i) => row(i));
    const body = await (await list()).json();
    expect(state.calls).toContainEqual(['from', 'chat_attachments']);
    expect(state.calls).toContainEqual(['eq', 'user_id', 'u-me']);
    expect(state.calls).toContainEqual(['eq', 'status', 'ready']);
    expect(state.calls).toContainEqual(['not', 'conversation_id', 'is', null]);
    expect(body.data.files).toHaveLength(MY_FILES_PAGE);
    expect(body.data.files[0]).toMatchObject({ file_name: '예산 0.xlsx', source: ATTACHMENT_SOURCE_LABEL, conversation_title: '대화 0' });
    const last = body.data.files[MY_FILES_PAGE - 1];
    expect(parseCursor(body.data.next)).toEqual({ at: last.created_at, id: last.id });
    expect(JSON.stringify(body)).not.toContain('chat-uploads');
  });
  it('?q=는 같은 다듬기로 이름에 든 것만, 꼴이 이상한 기준은 400, 조회 실패는 503', async () => {
    await list(`?q=${encodeURIComponent(' 50%\n예산 ')}`);
    expect(state.calls).toContainEqual(['ilike', 'file_name', '%50\\% 예산%']);
    state.calls = [];
    expect((await list('?cursor=x')).status).toBe(400);
    expect(state.calls).toEqual([]);
    state.error = { message: 'down' };
    expect((await list()).status).toBe(503);
  });
});

describe('대화에 올린 파일 내려받기', () => {
  it('주인의 대화에 보낸 읽힌 첨부만 60초 서명 주소로 302', async () => {
    state.single = { storage_path: 'chat-uploads/o/u-me/a.xlsx', file_name: '예산.xlsx' };
    const res = await original(ID.toUpperCase());
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://storage/x?token=1');
    expect(state.calls).toContainEqual(['eq', 'id', ID]);
    expect(state.calls).toContainEqual(['eq', 'user_id', 'u-me']);
    expect(state.calls).toContainEqual(['eq', 'status', 'ready']);
    expect(state.calls).toContainEqual(['not', 'conversation_id', 'is', null]);
    expect(state.calls).toContainEqual(['sign', 'chat-uploads/o/u-me/a.xlsx', '예산.xlsx']);
  });
  it('남의 것·없는 것·이상한 id는 404, 로그인 안 하면 401, 조회 실패 503, 주소 실패 500', async () => {
    expect((await original(ID)).status).toBe(404);
    state.calls = [];
    expect((await original('nope')).status).toBe(404);
    expect(state.calls).toEqual([]);
    state.session = null;
    expect((await original(ID)).status).toBe(401);
    state.session = { user: { id: 'u-me' } };
    state.error = { message: 'down' };
    expect((await original(ID)).status).toBe(503);
    state.error = null; state.single = { storage_path: 'p', file_name: 'f' }; state.signed = null;
    expect((await original(ID)).status).toBe(500);
  });
});

describe('통합 찾기 규칙과 화면', () => {
  it('찾기 규칙은 잎 파일 하나 — 옛 이름도 그대로 내보낸다', () => {
    expect(generated.normalizeFileQuery).toBe(normalizeFileQuery);
    expect(matchesFileQuery(null, 'a')).toBe(true);
    expect(matchesFileQuery('  주간\n보고 ', '2026 주간 보고.hwpx')).toBe(true);
    expect(matchesFileQuery('HWPX', '주간.hwpx')).toBe(true);
    expect(matchesFileQuery('결산', '보고서.hwpx', '예산 결산 작업')).toBe(true);
    expect(matchesFileQuery('결산', '보고서.hwpx', null)).toBe(false);
    expect(readFileSync('src/lib/file-search.ts', 'utf8')).not.toMatch(/^import /m);
  });
  it('결과물 화면 — 한 칸 찾기가 세 목록에, 업무 결과물은 화면에서 거르고, 올린 파일은 주인만 받는 원본 주소', () => {
    const page = readFileSync('src/app/files/page.tsx', 'utf8');
    expect(page).toContain('aria-label="내 파일 찾기"');
    expect(page).toContain('matchesFileQuery(query, f.file_name, f.taskTitle)');
    expect(page).toContain('endpoint="/api/attachments/mine"');
    expect(page).toContain('downloadHref={(id) => `/api/attachments/${id}/original`}');
    expect(page).toContain('useEffect(() => { void load(null); }, [query, endpoint]);');
    expect(page).not.toMatch(/^import (?!type ).*(my-generated-files|my-attachments)/m);
  });
});
