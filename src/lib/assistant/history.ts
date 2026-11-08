// src/lib/assistant/history.ts
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { LlmMessage } from '@/lib/llm/types';
import { HISTORY_MESSAGE_LIMIT } from './types';

/**
 * 최신순으로 받은 행을 시간순으로 되돌리고, 모델이 받을 수 있는 꼴로 다듬는다.
 * 답변을 근거로 고쳐 썼으면(2026-11-08, `revised`) 다음 턴은 고쳐 쓴 답을 앞 답변으로 본다 — 직원이 고친 숫자를 믿고 이어 묻기 때문이다
 */
export function trimHistory(rowsNewestFirst: { role: string; content: string | null; revised?: string | null }[]): LlmMessage[] {
  const history = [...rowsNewestFirst]
    .reverse()
    .map((m) => ({ role: m.role, content: m.role === 'assistant' && typeof m.revised === 'string' && m.revised.trim() ? m.revised : m.content }))
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && Boolean(m.content?.trim()))
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content as string }));

  // Claude는 user 메시지로 시작해야 한다
  while (history.length > 0 && history[0].role !== 'user') history.shift();
  return history;
}

export async function loadHistory(conversationId: string): Promise<LlmMessage[]> {
  const { data } = await supabaseAdmin
    .from('messages')
    .select('role, content, revised:source_references->revision->>text')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(HISTORY_MESSAGE_LIMIT);
  return trimHistory((data ?? []) as unknown as { role: string; content: string | null; revised: string | null }[]);
}
