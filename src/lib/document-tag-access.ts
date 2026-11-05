// src/lib/document-tag-access.ts
// 문서 태그를 고치거나 초안을 만들 수 있는가(0060) — 태그 저장(PATCH /api/documents/[id])과 AI 초안(…/tag-suggest)이 같은 규칙을 쓴다.
import { canEditAgent, type ActorScope, type AgentAccessInfo } from '@/lib/agent-permissions';
import { loadAgentAccess } from '@/lib/agent-store';
import { canReadDocument } from '@/lib/document-files';

export interface TaggableDocument {
  agent_id: string | null;
  department_id: string;
  organization_id: string | null;
  visibility: string | null;
}

/**
 * 볼 수 있는 문서이고(문서 목록과 같은 기준), 그 문서의 부서를 관리하는 관리자이거나 그 비서를 고칠 수 있는 사람.
 * 'hidden'이면 라우트는 없는 것처럼 404를 준다
 */
export async function documentTagAccess(
  doc: TaggableDocument,
  actor: ActorScope,
  loadAgent: (id: string) => Promise<AgentAccessInfo | null> = loadAgentAccess
): Promise<'allowed' | 'forbidden' | 'hidden'> {
  if (!canReadDocument(doc, actor)) return 'hidden';
  if (actor.isAdmin && actor.managedDepartmentIds.includes(doc.department_id)) return 'allowed';
  if (doc.agent_id) {
    const agent = await loadAgent(doc.agent_id);
    if (agent && !agent.deleted_at && canEditAgent(agent, actor)) return 'allowed';
  }
  return 'forbidden';
}
