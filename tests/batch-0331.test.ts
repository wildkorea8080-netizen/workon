// tests/batch-0331.test.ts
// 공개 공유 대화에 '근거로 고쳐 쓴 답'(2026-11-26, 마이그레이션 없음) — 공유한 때까지 고쳐 쓴 답의 글만, 근거 발췌는 읽지도 않는다.
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { SHARED_REVISION_MAX, sharedMessages, type SharedMessageRow } from '@/lib/shared-conversation';

const q: SharedMessageRow = { id: 'q', role: 'user', content: '여비는?', created_at: '2026-11-20T01:00:00Z' };
const a = (over: Partial<SharedMessageRow> = {}): SharedMessageRow => ({ id: 'a', role: 'assistant', content: '원래 답', created_at: '2026-11-20T01:00:00Z', revised: '고쳐 쓴 답', revised_status: 'done', revised_at: '2026-11-20T02:00:00Z', ...over });

describe('공개 조회의 고쳐 쓴 답', () => {
  it('공유한 때까지 다 고쳐 쓴 답만 붙이고, 원래 답은 그대로', () => {
    expect(sharedMessages([q, a()], '2026-11-21T00:00:00Z')).toEqual([
      { id: 'q', role: 'user', content: '여비는?', created_at: q.created_at },
      { id: 'a', role: 'assistant', content: '원래 답', created_at: q.created_at, revision: { text: '고쳐 쓴 답', created_at: '2026-11-20T02:00:00Z' } },
    ]);
  });
  it('공유한 뒤 고쳐 쓴 답·고쳐 쓰는 중·빈 글·질문 행은 붙이지 않는다', () => {
    expect(sharedMessages([a()], '2026-11-20T01:30:00Z')[0].revision).toBeUndefined();
    expect(sharedMessages([a({ revised_status: 'pending' })], null)[0].revision).toBeUndefined();
    expect(sharedMessages([a({ revised: '  ' })], null)[0].revision).toBeUndefined();
    expect(sharedMessages([{ ...q, revised: 'x', revised_status: 'done' }], null)[0].revision).toBeUndefined();
    // 공유한 때가 없는 옛 공유는 다 고쳐 쓴 것이면 붙인다(메시지도 전부 보이는 것과 같다)
    expect(sharedMessages([a()], null)[0].revision?.text).toBe('고쳐 쓴 답');
    // 공유한 때가 있으면 고쳐 쓴 때를 모르는 답은 붙이지 않는다
    expect(sharedMessages([a({ revised_at: null })], '2026-11-21T00:00:00Z')[0].revision).toBeUndefined();
  });
  it('글 상한·응답 칸은 정해 둔 것만', () => {
    expect(sharedMessages([a({ revised: 'x'.repeat(SHARED_REVISION_MAX + 5) })], null)[0].revision!.text).toHaveLength(SHARED_REVISION_MAX);
    expect(Object.keys(sharedMessages([a()], null)[0]).sort()).toEqual(['content', 'created_at', 'id', 'revision', 'role']);
  });
  it('연결 — 고쳐 쓴 답은 글·상태·때만 골라 읽고, 화면이 원래 답 아래에 보인다', () => {
    const route = readFileSync('src/app/api/shared/[token]/route.ts', 'utf8');
    expect(route).toContain('revised:source_references->revision->>text,');
    expect(route).toContain('revised_status:source_references->revision->>status,');
    expect(route).not.toMatch(/source_references[,\s)]/);
    expect(route).toContain('messages: sharedMessages(row.messages ?? [], row.metadata?.shared_at),');
    const page = readFileSync('src/app/shared/[token]/page.tsx', 'utf8');
    expect(page).toContain("{msg.role === 'assistant' && msg.revision && (");
  });
});
