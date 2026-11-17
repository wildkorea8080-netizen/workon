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

/**
 * 한 턴의 질문·답 두 행은 한 번에 들어가 `created_at`이 **같다**(기본값 now()는 트랜잭션 시각 — 운영 10턴 모두 같음, 2026-11-18 확인).
 * 시각만으로 줄 세우면 같은 시각 안의 순서는 정해지지 않고, 운영은 최신순에서도 '질문, 답' 순으로 돌려줘 시간순으로 뒤집으면
 * [답1, 질문1, 답2, 질문2, …] → 앞 답을 떼어 **질문1 → 답2**처럼 한 칸씩 밀린 이력이 모델에 갔다(오류 없이). 같은 시각이면 역할로 가른다:
 * 최신순은 답(assistant)이 먼저, 시간순은 질문(user)이 먼저('assistant' < 'user')
 */
export async function loadHistory(conversationId: string): Promise<LlmMessage[]> {
  const { data } = await supabaseAdmin
    .from('messages')
    .select('role, content, revised:source_references->revision->>text')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .order('role', { ascending: true })
    .limit(HISTORY_MESSAGE_LIMIT);
  return trimHistory((data ?? []) as unknown as { role: string; content: string | null; revised: string | null }[]);
}
