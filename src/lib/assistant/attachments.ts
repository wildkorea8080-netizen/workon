// src/lib/assistant/attachments.ts
import { MAX_ATTACHMENTS_PER_SEND } from '@/lib/attachments/limits';
import type { AttachmentRecord } from '@/lib/attachments/store';
import type { AttachmentSummary } from '@/lib/attachments/types';
import type { Capability, TurnAttachment } from '@/lib/capabilities/types';

/**
 * 채팅 요청의 첨부(attachment_ids) — DB를 보지 않는 부분만 둔다. 묶기·조회는 prepare.ts가 store로 한다.
 */

export const MSG_FILES_NOT_ACCEPTED = '이 비서는 파일을 받지 않습니다. 파일 받아 읽기를 켠 비서에서 물어 주세요.';

/** 요청의 첨부 id를 받을 수 있는가. 받을 수 없으면 400 사유 */
export function attachmentRequestError(ids: unknown, capabilities: Capability[]): string | null {
  if (ids === undefined || ids === null) return null;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) return '첨부 형식이 올바르지 않습니다.';
  if (ids.length === 0) return null;
  if (ids.length > MAX_ATTACHMENTS_PER_SEND) return `첨부는 한 번에 ${MAX_ATTACHMENTS_PER_SEND}개까지 보낼 수 있습니다.`;
  // 화면에서 버튼을 숨겨도 그건 표시일 뿐이다. 꺼진 비서에 파일을 넣지 못하게 여기서 막는다
  if (!capabilities.some((c) => c.acceptsFiles)) return MSG_FILES_NOT_ACCEPTED;
  return null;
}

/** ready인데 요약이 비었을 때(있으면 안 되지만) 첨부를 빼지 않는다 — 빼면 뒤 파일의 ref가 밀린다 */
const MISSING_SUMMARY: AttachmentSummary = { kind: 'text', chars: 0, tables: [], warnings: ['읽은 내용 요약이 없습니다.'] };

/**
 * 대화의 첨부 기록 → 이번 턴 첨부. ref(a1…)는 이 대화에 올린 순서(created_at, 같으면 id)를 따르므로 턴이 바뀌어도 같은 파일은 같은 ref다.
 * 저장소 경로는 여기서 뗀다 — ctx는 능력·도구로 퍼진다.
 */
export function toTurnAttachments(records: AttachmentRecord[], newIds: string[]): TurnAttachment[] {
  const fresh = new Set(newIds);
  return [...records]
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    .map((r, i) => ({
      ref: `a${i + 1}`,
      id: r.id,
      fileName: r.file_name,
      summary: r.summary ?? MISSING_SUMMARY,
      isNew: fresh.has(r.id),
    }));
}
