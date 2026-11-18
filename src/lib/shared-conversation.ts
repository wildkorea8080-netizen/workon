// src/lib/shared-conversation.ts
// 대화 공개 공유(로그인 없이 보는 링크)의 범위 — 아무것도 import하지 않는다.

export type SharedMessage = { id: string; role: string; content: string; created_at: string };

/**
 * 공유한 때까지의 메시지만(2026-11-18). `sharedAt`이 없거나 날짜가 아니면(이 기능 전에 공유한 대화) 전부.
 * 한 턴의 질문·답은 같은 시각에 들어가므로 `<=`로 본다.
 *
 * 예전에는 링크가 대화의 '지금'을 보여 줘, 공유한 뒤 이어 쓴 대화가 링크를 받은 사람에게 그대로 보였다.
 */
export function messagesUntil(messages: SharedMessage[], sharedAt: unknown): SharedMessage[] {
  if (typeof sharedAt !== 'string') return messages;
  const limit = Date.parse(sharedAt);
  if (!Number.isFinite(limit)) return messages;
  return messages.filter((m) => {
    const at = Date.parse(m.created_at);
    return Number.isFinite(at) && at <= limit;
  });
}
