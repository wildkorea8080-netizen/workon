import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-19 — 대화 이름 바꾸기·지우기·열기.
 * - 사이드바가 서버 응답을 보지 않아, 이름 바꾸기·지우기가 **실패해도 화면에서는 된 것처럼** 바뀌거나 사라졌다
 * - 이름은 글인지·길이를 보지 않았다(사이드바·공개 공유 화면에 그대로 실림), 없는 대화의 이름 바꾸기는 500
 * - 대화 열기·지우기 전 확인에서 못 읽은 것을 '찾을 수 없음'(404)으로 답했다
 */

type Call = { table: string; ops: Array<[string, unknown[]]> };
type Result = { data?: unknown; error: unknown };
const ERR = { code: 'XX000', message: 'boom' };

const state: { session: unknown; calls: Call[]; single: Result; update: Result; existing: Result } = {
  session: null, calls: [], single: { data: null, error: null }, update: { data: null, error: null }, existing: { data: null, error: null },
};
const did = (c: Call, name: string) => c.ops.some(([n]) => n === name);

function resolve(c: Call): Result {
  if (did(c, 'update')) return state.update;
  if (did(c, 'single')) return state.single;
  if (did(c, 'maybeSingle')) return state.existing;
  return { data: null, error: null };
}

vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => state.session }));
vi.mock('@/lib/message-feedback', () => ({ loadConversationFeedback: async () => ({}) }));
vi.mock('@/lib/generated-files', () => ({ deleteConversationFiles: async () => undefined }));
vi.mock('@/lib/attachments/store', () => ({ deleteConversationAttachments: async () => undefined }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const call: Call = { table, ops: [] };
      state.calls.push(call);
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'order', 'update', 'delete']) b[n] = (...args: unknown[]) => { call.ops.push([n, args]); return b; };
      b.single = async () => { call.ops.push(['single', []]); return resolve(call); };
      b.maybeSingle = async () => { call.ops.push(['maybeSingle', []]); return resolve(call); };
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(resolve(call)).then(res, rej);
      return b;
    },
  },
}));

import { cleanConversationTitle, MAX_CONVERSATION_TITLE } from '@/lib/conversation-title';
import { DELETE, GET, PUT } from '@/app/api/conversations/[id]/route';

const params = { params: { id: 'c1' } };
const req = (body?: unknown) => new Request('http://x/api/conversations/c1', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
}) as never;

beforeEach(() => {
  state.session = { user: { id: 'u1' } };
  state.calls = [];
  state.single = { data: { id: 'c1', messages: [] }, error: null };
  state.update = { data: { id: 'c1', title: '새 이름', updated_at: 't' }, error: null };
  state.existing = { data: { id: 'c1' }, error: null };
});

describe('cleanConversationTitle', () => {
  it('줄바꿈·보이지 않는 글자를 빼고 공백을 하나로, 앞뒤를 뗀다', () => {
    expect(cleanConversationTitle('  여비\n규정​  문의 ')).toBe('여비 규정 문의');
  });
  it('글이 아니거나 비었거나 100자를 넘으면 null', () => {
    expect(cleanConversationTitle(123)).toBeNull();
    expect(cleanConversationTitle({ a: 1 })).toBeNull();
    expect(cleanConversationTitle('  ​ ')).toBeNull();
    expect(cleanConversationTitle('가'.repeat(MAX_CONVERSATION_TITLE))).toBe('가'.repeat(MAX_CONVERSATION_TITLE));
    expect(cleanConversationTitle('가'.repeat(MAX_CONVERSATION_TITLE + 1))).toBeNull();
  });
});

describe('PUT /api/conversations/[id] — 이름 바꾸기', () => {
  it('다듬은 이름을 저장하고 저장한 이름을 돌려준다(행 전체가 아니라 id·이름·시각)', async () => {
    const res = await PUT(req({ title: ' 새\n이름 ' }), params);
    expect(res.status).toBe(200);
    const up = state.calls.find((c) => did(c, 'update'))!;
    expect((up.ops.find(([n]) => n === 'update')![1][0] as { title: string }).title).toBe('새 이름');
    expect(up.ops).toContainEqual(['select', ['id, title, updated_at']]);
    expect(up.ops).toContainEqual(['eq', ['user_id', 'u1']]);
    expect((await res.json()).data.title).toBe('새 이름');
  });

  it('글이 아니거나 너무 긴 이름·깨진 본문은 400 — 저장하지 않는다', async () => {
    for (const body of [{ title: 5 }, { title: '가'.repeat(101) }, { title: '  ' }, '{깨짐']) {
      state.calls = [];
      const res = await PUT(req(body), params);
      expect(res.status).toBe(400);
      expect(state.calls).toHaveLength(0);
    }
  });

  it('남의·없는 대화면 404, 쓰기 실패는 500', async () => {
    state.update = { data: null, error: null };
    expect((await PUT(req({ title: 'a' }), params)).status).toBe(404);
    state.update = { data: null, error: ERR };
    const res = await PUT(req({ title: 'a' }), params);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('boom');
  });
});

describe('GET·DELETE — 못 읽은 것은 없음이 아니다', () => {
  it('열기: 행 없음은 404, 그 밖의 읽기 실패는 503', async () => {
    state.single = { data: null, error: { code: 'PGRST116', message: 'no rows' } };
    expect((await GET(req(), params)).status).toBe(404);
    state.single = { data: null, error: ERR };
    const res = await GET(req(), params);
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain('boom');
  });

  it('지우기 전 확인을 못 읽으면 503 — 아무것도 지우지 않는다', async () => {
    state.existing = { data: null, error: ERR };
    expect((await DELETE(req(), params)).status).toBe(503);
    expect(state.calls.some((c) => did(c, 'delete'))).toBe(false);
    state.existing = { data: null, error: null };
    expect((await DELETE(req(), params)).status).toBe(404);
  });
});

describe('사이드바 — 서버가 한 것만 화면에', () => {
  const src = readFileSync('src/components/layout/Sidebar.tsx', 'utf8');
  it('지우기는 응답이 ok일 때만 목록에서 뺀다', () => {
    const del = src.slice(src.indexOf('const handleDelete'), src.indexOf('const startRename'));
    expect(del.indexOf('if (!res.ok || !result?.ok)')).toBeGreaterThan(-1);
    expect(del.indexOf('if (!res.ok || !result?.ok)')).toBeLessThan(del.indexOf('setConversations('));
  });
  it('이름 바꾸기는 서버가 저장한 이름으로만 바꾸고, 실패하면 알린다', () => {
    const ren = src.slice(src.indexOf('const submitRename'), src.indexOf('const handleShare'));
    expect(ren).toContain("typeof result.data?.title !== 'string'");
    expect(ren).toContain('const saved: string = result.data.title;');
    expect(ren).toContain('showToast(');
    expect(ren.indexOf('return;')).toBeLessThan(ren.indexOf('setConversations('));
  });
  it('입력 칸도 100자까지', () => {
    expect(src).toContain('maxLength={MAX_CONVERSATION_TITLE}');
  });
});
