// src/lib/capabilities/attachment-access.ts
import { listConversationAttachments, loadExtract as loadStoredExtract } from '@/lib/attachments/store';
import type { AttachmentRecord } from '@/lib/attachments/store';
import type { AttachmentExtract } from '@/lib/attachments/types';
import type { TurnAttachment, TurnContext } from './types';

/**
 * 첨부 접근 — 파일을 받는 능력(file_read·table_merge)이 함께 쓴다.
 * 한 곳에 두는 이유: 두 능력이 따로 불러오면 같은 턴에 같은 파일을 두 번 내려받고,
 * 격리 조건(user_id·대화)이 한쪽에서만 바뀔 수 있다.
 */

/** 도구 입력의 ref(a1)로 이번 턴 첨부를 찾는다. uuid는 받지 않는다 — ctx에 있는 것만 */
export function findAttachment(ctx: TurnContext, ref: string): TurnAttachment | null {
  const key = typeof ref === 'string' ? ref.trim() : '';
  if (!key) return null;
  return ctx.attachments.find((a) => a.ref === key) ?? null;
}

/**
 * 본문은 ctx의 사용자·대화로 기록을 다시 찾아 불러온다(user_id 조건). ctx에 저장소 경로를 싣지 않기
 * 위해서다. 한 턴 안에서는 목록 조회도, 첨부마다의 본문 내려받기도 한 번 — ctx 객체마다 기억한다.
 * 못 불러온 것(null)은 기억하지 않는다 — 다음 읽기에서 다시 시도할 수 있게.
 */
interface TurnCache {
  records?: Promise<AttachmentRecord[]>;
  extracts: Map<string, Promise<AttachmentExtract | null>>;
}
const turnCache = new WeakMap<TurnContext, TurnCache>();

export async function loadTurnExtract(ctx: TurnContext, attachment: TurnAttachment): Promise<AttachmentExtract | null> {
  let cache = turnCache.get(ctx);
  if (!cache) {
    cache = { extracts: new Map() };
    turnCache.set(ctx, cache);
  }
  const hit = cache.extracts.get(attachment.id);
  if (hit) return hit;

  cache.records ??= listConversationAttachments(ctx.userId, ctx.conversationId);
  const records = cache.records;
  const pending = records.then((rows) => {
    const row = rows.find((r) => r.id === attachment.id);
    return row ? loadStoredExtract(row) : null;
  });
  cache.extracts.set(attachment.id, pending);
  const extract = await pending;
  if (!extract) cache.extracts.delete(attachment.id);
  return extract;
}
