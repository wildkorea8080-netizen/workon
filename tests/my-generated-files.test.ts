import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';

/** 결과물 화면의 '대화에서 만든 파일'(2026-11-07) — 내 것만, 최근 것부터 50개씩, 저장소 경로 없이 */

const state = {
  session: { user: { id: 'u-me' } } as { user: { id: string } } | null,
  rows: [] as Array<Record<string, unknown>>,
  calls: [] as Array<[string, ...unknown[]]>,
  error: null as { message: string } | null,
};
vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => state.session }));
vi.mock('@/lib/supabaseAdmin', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'or', 'ilike']) chain[m] = (...args: unknown[]) => { state.calls.push([m, ...args]); return chain; };
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: state.rows, error: state.error }).then(resolve);
  return { supabaseAdmin: { from: (table: string) => { state.calls.push(['from', table]); return chain; } } };
});

import { GET } from '@/app/api/files/route';
import { MY_FILES_PAGE, fileNamePattern, normalizeFileQuery, parseCursor, toMyFile } from '@/lib/my-generated-files';
import { encodeHistoryCursor } from '@/lib/apps/history';
import { fileBadge } from '@/lib/file-badge';

const row = (i: number, over: Record<string, unknown> = {}) => ({
  id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`, file_name: `보고서 ${i}.hwpx`, size_bytes: 1000 + i, created_at: `2026-11-0${(i % 9) + 1}T00:00:00.000Z`, template_name: '일반 보고서',
  conversation_id: `c-${i}`, conversation: { title: `대화 ${i}` }, storage_path: `generated/o/c/${i}.hwpx`, ...over,
});
const get = (q = '') => GET(new Request(`http://x/api/files${q}`) as never);

beforeEach(() => { state.session = { user: { id: 'u-me' } }; state.rows = []; state.calls = []; state.error = null; });

describe('목록', () => {
  it('로그인해야 한다', async () => {
    state.session = null;
    expect((await get()).status).toBe(401);
    expect(state.calls).toEqual([]);
  });

  it('요청자 것만, 최근 것부터, 한 개 더 읽어 다음 쪽을 안다 — 화면에는 저장소 경로가 없다', async () => {
    state.rows = Array.from({ length: MY_FILES_PAGE + 1 }, (_, i) => row(i));
    const body = await (await get()).json();
    expect(state.calls).toContainEqual(['from', 'generated_files']);
    expect(state.calls).toContainEqual(['eq', 'user_id', 'u-me']);
    expect(state.calls).toContainEqual(['order', 'created_at', { ascending: false }]);
    expect(state.calls).toContainEqual(['limit', MY_FILES_PAGE + 1]);
    expect(body.data.files).toHaveLength(MY_FILES_PAGE);
    const last = body.data.files[MY_FILES_PAGE - 1];
    expect(parseCursor(body.data.next)).toEqual({ at: last.created_at, id: last.id });
    expect(state.calls).toContainEqual(['order', 'id', { ascending: false }]);
    expect(JSON.stringify(body)).not.toContain('storage_path');
    expect(JSON.stringify(body)).not.toContain('generated/o/c');
  });

  it('다음 쪽은 (시각, id) 앞의 것만 — 시각이 같은 파일도 빠지지 않는다. 꼴이 이상한 기준은 400', async () => {
    state.rows = [row(1)];
    const at = '2026-11-05T00:00:00.000Z'; const id = '11111111-2222-3333-4444-555555555555';
    const body = await (await get(`?cursor=${encodeURIComponent(encodeHistoryCursor(at, id))}`)).json();
    expect(state.calls).toContainEqual(['or', `created_at.lt.${at},and(created_at.eq.${at},id.lt.${id})`]);
    expect(body.data.next).toBeNull();
    state.calls = [];
    for (const bad of ['x', encodeURIComponent(encodeHistoryCursor("2026-11-05' or 1=1", id)), encodeURIComponent(encodeHistoryCursor(at, 'not-uuid'))]) {
      expect((await get(`?cursor=${bad}`)).status).toBe(400);
    }
    expect(state.calls).toEqual([]);
  });

  it('파일 이름 찾기(2026-11-08) — ?q=는 다듬어 이름에 든 파일만, 쪽 넘기기도 같은 조건, 비면 전체', async () => {
    state.rows = [row(1)];
    await get(`?q=${encodeURIComponent('  주간\n보고 ')}`);
    expect(state.calls).toContainEqual(['ilike', 'file_name', '%주간 보고%']);
    expect(state.calls).toContainEqual(['eq', 'user_id', 'u-me']);
    state.calls = [];
    const at = '2026-11-05T00:00:00.000Z'; const id = '11111111-2222-3333-4444-555555555555';
    await get(`?q=${encodeURIComponent('보고')}&cursor=${encodeURIComponent(encodeHistoryCursor(at, id))}`);
    expect(state.calls).toContainEqual(['ilike', 'file_name', '%보고%']);
    expect(state.calls.some(c => c[0] === 'or')).toBe(true);
    state.calls = [];
    await get('?q=%20%20');
    expect(state.calls.some(c => c[0] === 'ilike')).toBe(false);
  });

  it('찾기 글 — LIKE 특수 글자는 글자 그대로, 제어·서식 글자 제거, 60자', () => {
    expect(fileNamePattern('50%_달성\\')).toBe('%50\\%\\_달성\\\\%');
    expect(normalizeFileQuery('‮보고​서\t 2026')).toBe('보고 서 2026');
    expect(normalizeFileQuery('가'.repeat(80))).toHaveLength(60);
    expect(normalizeFileQuery('   ')).toBeNull();
    expect(normalizeFileQuery(null)).toBeNull();
  });

  it('조회 실패는 503', async () => {
    state.error = { message: 'down' };
    expect((await get()).status).toBe(503);
  });

  it('한 줄 — 만든 곳은 양식·능력 이름, 대화 제목이 없으면 null', () => {
    expect(toMyFile(row(1, { template_name: '표 합치기', conversation: [{ title: '  ' }] }) as never)).toEqual({
      id: '00000000-0000-0000-0000-000000000001', file_name: '보고서 1.hwpx', size_bytes: 1001, created_at: '2026-11-02T00:00:00.000Z', source: '표 합치기', conversation_id: 'c-1', conversation_title: null,
    });
    expect(toMyFile(row(2, { template_name: null, size_bytes: null }) as never)).toMatchObject({ source: '대화', size_bytes: 0 });
  });
});

describe('화면', () => {
  it('결과물 화면에 대화 파일 묶음 — 내려받기는 주인만 받는 /api/files/[id], 대화로 가는 링크', () => {
    const page = readFileSync('src/app/files/page.tsx', 'utf8');
    expect(page).toContain('<ConversationFiles />');
    expect(page).toContain('href={`/api/files/${f.id}`}');
    expect(page).toContain('/chat?conv=${encodeURIComponent(f.conversation_id)}');
    // 서버 모듈(supabaseAdmin)은 꼴만 가져온다 — 값을 가져오면 화면 묶음에 서버 코드가 들어간다
    expect(page).toContain("import type { MyGeneratedFile } from '@/lib/my-generated-files';");
    expect(page).not.toMatch(/^import (?!type ).*my-generated-files/m);
    // 이름 찾기 — '더 보기'는 건 글로 이어 읽고, 늦게 온 옛 응답은 버린다
    expect(page).toContain('aria-label="파일 이름으로 찾기"');
    expect(page).toContain("if (q) params.set('q', q);");
    expect(page).toContain('if (seq !== latest.current) return;');
  });

  it('배지 — HWP·DOC·XLS', () => {
    expect(['a.hwpx', 'a.HWP', 'b.docx', 'c.xlsx', 'd.pdf', 'noext'].map(fileBadge)).toEqual(['HWP', 'HWP', 'DOC', 'XLS', 'PDF', 'NOEX']);
  });
});
