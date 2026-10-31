import { describe, expect, it, vi } from 'vitest';
import { openEvidenceOriginal } from '@/lib/work/evidence-access';
import type { WorkContext } from '@/lib/work/context';
const id = '11111111-1111-4111-8111-111111111111';
const doc = '22222222-2222-4222-8222-222222222222';
const actor = { userId: 'user', organizationId: 'org', departmentId: 'dept', isAdmin: false, managedDepartmentIds: [] };
function fixture() {
  const task = { id, organization_id: 'org', owner_id: 'user', status: 'draft', current_document_version_id: 'version', app_snapshot: { agentId: 'agent' } };
  const version = { task_id: id, content: { appEvidence: [{ id: 'rag:123', name: '문서', text: '근거', documentId: doc }] } };
  const ctx = { store: { getTask: vi.fn(async () => task), getMembers: async () => [], getVersion: vi.fn(async () => version) } } as unknown as WorkContext;
  const reader = vi.fn(async () => 'signed-url');
  return { ctx, task, version, reader };
}
describe('작업 근거 원문 접근', () => {
  it('작업과 현재 판에 속한 문서만 원문 권한 조회로 전달한다', async () => {
    const { ctx, reader } = fixture();
    expect(await openEvidenceOriginal(ctx, actor, id, doc, reader)).toBe('signed-url');
    expect(reader).toHaveBeenCalledWith(doc, 'agent');
    expect(ctx.store.getTask).toHaveBeenCalledWith(id, 'org');
  });
  it('남의 비공유 작업은 원문 조회 전에 거절한다', async () => {
    const { ctx, task, reader } = fixture(); task.owner_id = 'other';
    await expect(openEvidenceOriginal(ctx, actor, id, doc, reader)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(reader).not.toHaveBeenCalled();
  });
  it('현재 판에서 사용하지 않은 문서는 조회하지 않는다', async () => {
    const { ctx, reader } = fixture();
    await expect(openEvidenceOriginal(ctx, actor, id, id, reader)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(reader).not.toHaveBeenCalled();
  });
  it('다른 작업의 판은 사용하지 않는다', async () => {
    const { ctx, version, reader } = fixture(); version.task_id = 'other';
    await expect(openEvidenceOriginal(ctx, actor, id, doc, reader)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(reader).not.toHaveBeenCalled();
  });
});
