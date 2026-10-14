// src/lib/assistant/history.ts
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { LlmMessage } from '@/lib/llm/types';
import { HISTORY_MESSAGE_LIMIT } from './types';

/** 최신순으로 받은 행을 시간순으로 되돌리고, 모델이 받을 수 있는 꼴로 다듬는다. */
export function trimHistory(rowsNewestFirst: { role: string; content: string | null }[]): LlmMessage[] {
  const history = [...rowsNewestFirst]
    .reverse()
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && Boolean(m.content?.trim()))
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content as string }));

  // Claude는 user 메시지로 시작해야 한다
  while (history.length > 0 && history[0].role !== 'user') history.shift();
  return history;
}

export async function loadHistory(conversationId: string): Promise<LlmMessage[]> {
  const { data } = await supabaseAdmin
    .from('messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(HISTORY_MESSAGE_LIMIT);
  return trimHistory((data ?? []) as { role: string; content: string | null }[]);
}
