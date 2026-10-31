import type { WorkContext } from './context';
import { loadTask } from './services';
import { storedAppEvidence } from './app-evidence';
import { WorkError, type WorkActor } from './types';

/** 작업 접근과 현재 판의 근거 소속을 확인한 뒤에만 원문 권한 조회를 실행한다. */
export async function openEvidenceOriginal(ctx: WorkContext, actor: WorkActor, taskId: string, documentId: string, reader: (documentId: string, agentId: string) => Promise<string>) {
  const { task } = await loadTask(ctx, actor, taskId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(documentId) || !task.current_document_version_id || !task.app_snapshot) throw new WorkError('NOT_FOUND', '원문을 찾을 수 없습니다.', 404);
  const version = await ctx.store.getVersion(task.current_document_version_id, actor.organizationId);
  if (!version || version.task_id !== task.id || !storedAppEvidence(version.content).some((e) => e.documentId === documentId)) throw new WorkError('NOT_FOUND', '원문을 찾을 수 없습니다.', 404);
  return reader(documentId, task.app_snapshot.agentId);
}
