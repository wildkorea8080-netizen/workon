// src/lib/shared-conversation.ts
// 대화 공개 공유(로그인 없이 보는 링크)의 범위 — 아무것도 import하지 않는다.

export type SharedMessage = { id: string; role: string; content: string; created_at: string; /** 근거로 고쳐 쓴 답(2026-11-26) — 공유한 때까지 고쳐 쓴 것만, 글만 */ revision?: { text: string; created_at: string } };
/** 공개 조회가 읽는 메시지 행 — 고쳐 쓴 답은 글·상태·때만 골라 읽는다(근거 발췌는 읽지 않음) */
export type SharedMessageRow = { id: string; role: string; content: string; created_at: string; revised?: string | null; revised_status?: string | null; revised_at?: string | null };
/** 공개 화면에 싣는 고쳐 쓴 답 글의 상한 */
export const SHARED_REVISION_MAX = 20_000;

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

/**
 * 공개 조회의 메시지(2026-11-26) — 공유한 때까지의 메시지(`messagesUntil`)에, 답변이면 **공유한 때까지 다 고쳐 쓴** 답의 글을 붙인다.
 * 공유한 뒤 고쳐 쓴 답은 싣지 않는다(공유한 뒤 이어 쓴 대화를 싣지 않는 것과 같다 — 다시 공유하면 보인다). 근거 발췌·숫자 확인은 싣지 않는다
 */
export function sharedMessages(rows: SharedMessageRow[], sharedAt: unknown): SharedMessage[] {
  const limit = typeof sharedAt === 'string' ? Date.parse(sharedAt) : NaN;
  return messagesUntil(rows, sharedAt).map((r) => {
    const base: SharedMessage = { id: r.id, role: r.role, content: r.content, created_at: r.created_at };
    const row = r as SharedMessageRow;
    if (row.role !== 'assistant' || row.revised_status !== 'done' || typeof row.revised !== 'string' || !row.revised.trim()) return base;
    const at = typeof row.revised_at === 'string' ? Date.parse(row.revised_at) : NaN;
    if (Number.isFinite(limit) && !(Number.isFinite(at) && at <= limit)) return base;
    return { ...base, revision: { text: row.revised.slice(0, SHARED_REVISION_MAX), created_at: Number.isFinite(at) ? row.revised_at! : '' } };
  });
}
