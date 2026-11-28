// tests/batch-0351.test.ts
// 지난 대화 찾기(2026-11-28) — 대화 목록의 찾기 칸이 화면에 읽어 둔 최근 80개의 제목만 걸러 오래된 대화·내용으로는 찾을 수 없었다.
// 두 글자부터 내 모든 대화의 제목·메시지 글을 서버에서 찾는다
import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
import { conversationQuery, mergeConversationHits, searchMyConversations } from '@/lib/conversation-search';
import { searchActive } from '@/components/layout/conversation-search-ui';

const conv = (id: string, updated_at: string, title = id) => ({ id, title, created_at: updated_at, updated_at, agent: null });

describe('찾기 글', () => {
  it('두 글자부터, 제어·보이지 않는 글자는 빼고 다듬는다', () => {
    expect(conversationQuery('여')).toBeNull();
    expect(conversationQuery('  ')).toBeNull();
    expect(conversationQuery(null)).toBeNull();
    expect(conversationQuery(' 여​비 ')).toBe('여 비');
    expect(conversationQuery('출장 여비')).toBe('출장 여비');
    expect(searchActive('여')).toBe(false);
    expect(searchActive('여비')).toBe(true);
    expect(searchActive(' ​여 ')).toBe(false);
  });
});

describe('결과 합치기', () => {
  it('제목에서 맞은 대화는 그대로, 내용에서만 맞은 대화는 맞은 자리 앞뒤와 함께 — 최근 순·대화마다 한 번', () => {
    const hits = mergeConversationHits(
      [conv('a', '2026-11-01T00:00:00Z', '여비 기준')],
      [
        { conversation_id: 'a', content: '여비는…', conversations: conv('a', '2026-11-01T00:00:00Z', '여비 기준') },
        { conversation_id: 'b', content: '국외 출장 여비는 기준표에 따릅니다', conversations: conv('b', '2026-11-20T00:00:00Z') },
        { conversation_id: 'b', content: '여비 두 번째', conversations: [conv('b', '2026-11-20T00:00:00Z')] },
        { conversation_id: 'c', content: '여비', conversations: null },
      ],
      '여비',
    );
    expect(hits.map((h) => h.id)).toEqual(['b', 'a']);
    expect(hits[0].snippet).toEqual({ before: '국외 출장 ', hit: '여비', after: '는 기준표에 따릅니다' });
    expect(hits[1].snippet).toBeNull();
  });
  it('상한까지만', () => {
    const titled = Array.from({ length: 40 }, (_, i) => conv(`c${i}`, `2026-11-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`));
    expect(mergeConversationHits(titled, [], 'c')).toHaveLength(30);
  });
});

describe('DB 찾기', () => {
  function fakeDb(results: { title?: unknown; messages?: unknown }) {
    const calls: Record<string, unknown[][]> = {};
    const chain = (table: string) => {
      const record = (name: string) => (...args: unknown[]) => { (calls[`${table}.${name}`] ??= []).push(args); return q; };
      const q: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'ilike', 'order', 'limit']) q[n] = record(n);
      q.then = (res: (v: unknown) => void) => res(table === 'conversations' ? results.title : results.messages);
      return q;
    };
    return { db: { from: (t: string) => chain(t) }, calls };
  }
  it('내 대화만 — 제목은 conversations.user_id, 내용은 같은 대화로 묶어서 — %·_는 글자 그대로', async () => {
    const { db, calls } = fakeDb({ title: { data: [], error: null }, messages: { data: [{ conversation_id: 'b', content: '50%_할인', conversations: { ...conv('b', '2026-11-20T00:00:00Z'), user_id: 'u1' } }], error: null } });
    const hits = await searchMyConversations('u1', '50%', db as never);
    expect(calls['conversations.eq']).toContainEqual(['user_id', 'u1']);
    expect(calls['messages.eq']).toContainEqual(['conversations.user_id', 'u1']);
    expect(calls['messages.ilike']).toContainEqual(['content', '%50\\%%']);
    expect(String(calls['messages.select'][0][0])).toContain('conversations!inner(');
    expect(hits[0]).not.toHaveProperty('user_id');
  });
  it('하나라도 못 읽으면 던진다(빈 결과로 보이지 않게)', async () => {
    const { db } = fakeDb({ title: { data: [], error: null }, messages: { data: null, error: { code: '57014' } } });
    await expect(searchMyConversations('u1', '여비', db as never)).rejects.toBeTruthy();
  });
});

describe('라우트·화면', () => {
  it('?q=는 두 글자 미만 400, 실패는 503', () => {
    const src = readFileSync('src/app/api/conversations/route.ts', 'utf8');
    expect(src).toMatch(/searchParams\.has\('q'\)/);
    expect(src).toMatch(/status: 400/);
    expect(src).toMatch(/searchMyConversations\(session\.user\.id, q\)/);
    expect(src).toMatch(/status: 503/);
  });
  it('화면은 늦게 온 앞 찾기를 버리고, 못 찾은 것을 "없음"으로 보이지 않는다', () => {
    const ui = readFileSync('src/components/layout/Sidebar.tsx', 'utf8');
    expect(ui).toMatch(/if \(!searchGate\.current\.isLatest\(ticket\)\) return;/);
    expect(ui).toMatch(/if \(!result\) \{ setSearchFailed\(SEARCH_FAILED\); return; \}/);
    expect(ui.indexOf('searchFailed ?')).toBeLessThan(ui.indexOf('든 대화가 없습니다'));
  });
});
