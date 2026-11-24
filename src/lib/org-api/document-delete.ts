// src/lib/org-api/document-delete.ts
// 기관 API의 문서 지우기(0104, 2026-11-24) — 범위 documents_delete(올리기 documents_write와 따로, 되돌릴 수 없어서).
// 기관 문서관리시스템이 폐지한 규정을 비서 문서함에서 내릴 때 `DELETE /api/v1/documents/{id}`.
//
// - 지울 수 있는 문서: **이 기관의 지우지 않은 공식·부서 비서**에 붙은 문서만(올리기·묻기와 같은 `writableAgent`).
//   나만의 비서·지운 비서·비서 없는 문서·다른 기관 문서는 모두 404(있는지 드러내지 않음).
// - 지우는 길은 관리자 문서 화면과 같다(`deleteAgentDocument` — NODA → 행 → 원본, NODA 실패는 deleting으로 남기고 502).
// - 지운 사람은 키를 만든 기관 전체 관리자(비서 타임라인 `document_removed`의 via 'org_api'), 보안 로그 high.
// - 지난 판 되살리기는 하지 않는다 — 새 판을 지워도 이미 내린 옛 판은 지난 판으로 남는다(화면 삭제와 같다).
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logSecurityEvent } from '@/lib/security-log';
import { loadAgentAccess } from '@/lib/agent-store';
import type { AgentAccessInfo } from '@/lib/agent-permissions';
import { deleteAgentDocument, type DeletableDocument } from '@/lib/document-delete';
import { writableAgent } from './spec';
import type { OrgApiContext } from './keys';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ORG_API_DOCUMENT_NOT_FOUND = '문서를 찾을 수 없습니다 — 이 기관의 공식·부서 비서 문서 id인지 확인해 주세요(이미 지운 문서도 이렇게 답합니다).';
export const ORG_API_DOCUMENT_UNREAD = '문서를 지금 확인하지 못했습니다. 잠시 뒤 다시 호출해 주세요(아무것도 지우지 않았습니다).';

type DocRow = DeletableDocument & { organization_id: string | null };

export interface OrgApiDeleteIo {
  /** 이 기관의 문서 행 — 없으면 null, 읽기 실패면 던진다 */
  loadDocument(id: string, organizationId: string): Promise<DocRow | null>;
  /** 비서 — 없으면 null, 읽기 실패면 던진다 */
  loadAgent(agentId: string): Promise<AgentAccessInfo | null>;
  remove: typeof deleteAgentDocument;
  log: typeof logSecurityEvent;
}

export function orgApiDeleteIo(): OrgApiDeleteIo {
  return {
    async loadDocument(id, organizationId) {
      const { data, error } = await supabaseAdmin
        .from('documents')
        .select('id, storage_path, agent_id, file_name, noda_filename, noda_status, organization_id')
        .eq('id', id)
        .eq('organization_id', organizationId)
        .maybeSingle();
      if (error) throw new Error(`documents: ${error.message}`);
      return (data as DocRow | null) ?? null;
    },
    loadAgent: (agentId) => loadAgentAccess(agentId),
    remove: deleteAgentDocument,
    log: logSecurityEvent,
  };
}

/** 지운다 — 성공이면 `{ data: { id, deleted: true } }`, 아니면 `{ status, message }` */
export async function deleteOrgApiDocument(
  ctx: OrgApiContext,
  rawId: unknown,
  io: OrgApiDeleteIo = orgApiDeleteIo(),
): Promise<{ data: unknown } | { status: number; message: string; code?: string }> {
  if (typeof rawId !== 'string' || !UUID.test(rawId)) return { status: 404, message: ORG_API_DOCUMENT_NOT_FOUND };
  const id = rawId.toLowerCase();

  let doc: DocRow | null;
  let agent: AgentAccessInfo | null = null;
  try {
    doc = await io.loadDocument(id, ctx.organizationId);
    if (doc?.agent_id) agent = await io.loadAgent(doc.agent_id);
  } catch {
    return { status: 503, message: ORG_API_DOCUMENT_UNREAD };
  }
  // 다른 기관(조회 조건으로 이미 걸러짐)·비서 없는 문서·나만의 비서·지운 비서의 문서는 없는 것과 같이
  if (!doc || doc.organization_id !== ctx.organizationId || !doc.agent_id || !writableAgent(agent, ctx.organizationId)) {
    return { status: 404, message: ORG_API_DOCUMENT_NOT_FOUND };
  }

  const removed = await io.remove(doc, ctx.creatorId, 'org_api');
  if (!removed.ok) return { status: removed.status, message: removed.message, ...(removed.status === 502 ? { code: 'documents_unavailable' } : {}) };

  await io.log(ctx.creatorDepartmentId, ctx.creatorId, 'org_api_document_deleted', {
    key_id: ctx.keyId, document_id: id, agent_id: doc.agent_id,
  }, 'high');
  return { data: { id, deleted: true } };
}
