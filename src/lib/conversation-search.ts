// src/lib/conversation-search.ts
// 지난 대화 찾기(2026-11-28) — 대화 목록의 찾기 칸이 화면에 읽어 둔 최근 80개의 제목만 걸러, 오래된 대화나
// '그때 물어본 출장 여비 답'처럼 내용으로는 찾을 수 없었다. 이제 내 모든 대화의 제목과 메시지 글을 DB에서 찾는다.
// 요청자의 대화만(conversations.user_id) — 관리자도 남의 대화를 찾지 못한다. 읽기 실패는 던진다(라우트가 503).
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { fileNamePattern, normalizeFileQuery } from '@/lib/file-search';
import { librarySnippet, type LibrarySnippet } from '@/lib/my-library-spec';

/** 찾기 글은 2자 이상 — 한 글자는 화면에 읽어 둔 목록만 거른다 */
export const CONVERSATION_QUERY_MIN = 2;
/** 돌려줄 대화 수 */
export const CONVERSATION_SEARCH_LIMIT = 30;
/** 내용에서 맞은 메시지를 읽을 상한 — 같은 대화의 여러 메시지가 맞을 수 있어 넉넉히 */
const MESSAGE_HIT_LIMIT = 120;

export type ConversationHit = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  is_shared?: boolean;
  agent?: { id: string; name: string } | null;
  /** 내용에서 맞았으면 맞은 자리 앞뒤(제목에서 맞았으면 없음) */
  snippet: LibrarySnippet | null;
};

/** 찾기 글 다듬기 — 2자 미만이면 null */
export function conversationQuery(raw: string | null | undefined): string | null {
  const q = normalizeFileQuery(raw);
  return q && Array.from(q).length >= CONVERSATION_QUERY_MIN ? q : null;
}

type ConvRow = Omit<ConversationHit, 'snippet'>;
type MessageRow = { conversation_id: string; content: string | null; conversations: ConvRow | ConvRow[] | null };

/** 제목에서 맞은 대화와 메시지에서 맞은 대화를 합쳐 최근에 쓴 순으로 */
export function mergeConversationHits(titled: ConvRow[], messages: MessageRow[], query: string, limit = CONVERSATION_SEARCH_LIMIT): ConversationHit[] {
  const byId = new Map<string, ConversationHit>();
  for (const c of titled) byId.set(c.id, { ...c, snippet: null });
  for (const m of messages) {
    const conv = Array.isArray(m.conversations) ? m.conversations[0] : m.conversations;
    if (!conv || byId.has(conv.id)) continue;
    // 메시지 글에서 맞은 자리 — 제목에 이미 든 낱말이면 앞에서 제목으로 잡혔다
    byId.set(conv.id, { ...conv, snippet: librarySnippet(m.content ?? '', '', query) });
  }
  return [...byId.values()].sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0)).slice(0, limit);
}

export async function searchMyConversations(userId: string, query: string, db = supabaseAdmin): Promise<ConversationHit[]> {
  const pattern = fileNamePattern(query);
  const [titled, messages] = await Promise.all([
    db.from('conversations')
      .select('id, title, created_at, updated_at, is_shared, agent:agents(id, name)')
      .eq('user_id', userId)
      .ilike('title', pattern)
      .order('updated_at', { ascending: false })
      .limit(CONVERSATION_SEARCH_LIMIT),
    db.from('messages')
      .select('conversation_id, content, conversations!inner(id, title, created_at, updated_at, is_shared, user_id, agent:agents(id, name))')
      .eq('conversations.user_id', userId)
      .ilike('content', pattern)
      .order('created_at', { ascending: false })
      .limit(MESSAGE_HIT_LIMIT),
  ]);
  if (titled.error) throw titled.error;
  if (messages.error) throw messages.error;
  const strip = (c: ConvRow & { user_id?: string }): ConvRow => {
    const { user_id: _drop, ...rest } = c;
    void _drop;
    return rest;
  };
  const msgRows = ((messages.data ?? []) as unknown as MessageRow[]).map((m) => {
    const conv = Array.isArray(m.conversations) ? m.conversations[0] : m.conversations;
    return { ...m, conversations: conv ? strip(conv as ConvRow & { user_id?: string }) : null };
  });
  return mergeConversationHits((titled.data ?? []) as unknown as ConvRow[], msgRows, query);
}
