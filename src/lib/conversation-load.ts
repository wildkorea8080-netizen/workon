// src/lib/conversation-load.ts
// 대화 화면이 '어느 대화를 읽을지' 정하는 규칙 — 아무것도 import하지 않는다(화면 공용 잎 파일, 시험이 React 없이 돌린다).
//
// 대화 화면(`ChatInterface`)은 대화 id가 바뀌면 그 대화의 메시지를 읽는다. 다만 **방금 만든 대화**(첫 질문을 보내 id가 생긴 것)는
// 답이 흘러나오는 중이라 다시 읽으면 안 된다 — 화면이 '마지막으로 다룬 id'(prev)를 미리 그 id로 적어 둬 가른다.
// 2026-11-20: 읽기를 버릴 수 있게 되면서(다른 대화로 바꿈·화면이 다시 그려짐) 규칙을 한 곳에 모았다. 버린 읽기는 끝을 알리지 않으므로
// (읽는 중 표시를 끄지 않는다) 다음 실행이 **반드시** 처음부터 해야 한다 — 그래서 버릴 때 prev를 어느 id와도 같지 않은 값으로 둔다.

/** 버린 읽기 표시 — 대화 id(uuid)·null 어느 것과도 같지 않다 */
export const DISCARDED_LOAD = '(discarded)';

/** 대화 id가 정해졌을 때 할 일: 그대로 둠(방금 만든 대화·같은 대화) / 비움(새 대화) / 읽음(저장된 다른 대화) */
export function loadStep(prev: string | null, conversationId: string | null): 'same' | 'blank' | 'load' {
  if (conversationId === prev) return 'same';
  return conversationId ? 'load' : 'blank';
}

/** 읽기를 버릴 때 prev — 그 읽기가 마지막으로 다룬 대화면 '버림'으로, 아니면(그 사이 다른 것을 다뤘으면) 그대로 */
export function prevAfterDiscard(prev: string | null, conversationId: string | null): string | null {
  return prev === conversationId ? DISCARDED_LOAD : prev;
}

type FetchLike = (input: string) => Promise<{ status: number; json(): Promise<unknown> }>;

export type ConversationFetch<T> = { ok: true; data: T } | { ok: false; notFound: boolean };

/** 대화 하나 읽기 — 없는 대화(404)와 지금 못 읽은 것(그 밖·연결 실패·몸을 못 읽음)을 가른다. 던지지 않는다 */
export async function fetchConversation<T = unknown>(id: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<ConversationFetch<T>> {
  try {
    const res = await fetchImpl(`/api/conversations/${encodeURIComponent(id)}`);
    const body = (await res.json().catch(() => null)) as { ok?: unknown; data?: T } | null;
    if (body && body.ok === true && body.data !== undefined) return { ok: true, data: body.data };
    return { ok: false, notFound: res.status === 404 };
  } catch {
    return { ok: false, notFound: false };
  }
}
