import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureAppSnapshot, workModelOptions, type WorkAppAgent } from '@/lib/work/app-binding';
import type { ActorScope } from '@/lib/agent-permissions';
import type { WorkContext } from '@/lib/work/context';
import type { WorkTaskRow, WorkActor } from '@/lib/work/types';
import { createTask, taskDto } from '@/lib/work/services';
import { llmGenerator } from '@/lib/work/generation/compose';
import { setLlmAdapterForTests } from '@/lib/llm';
import type { LlmRequest } from '@/lib/llm/types';

const id = '11111111-1111-4111-8111-111111111111';
const actor: WorkActor = { userId: 'user', organizationId: 'org', departmentId: 'dept', isAdmin: false, managedDepartmentIds: [] };
const scope: ActorScope = { ...actor, visibleDepartmentIds: ['dept'], managesWholeOrganization: false };
const agent = (): WorkAppAgent => ({ id, name: '보고서 비서', tier: 'personal', department_id: 'dept', organization_id: 'org', visibility: 'department', owner_id: 'user', created_by: 'user', is_active: true, is_published: false, deleted_at: null, approval_status: null, version: 3, approval_version: null, system_prompt: '검토 의견은 개조식으로 작성하세요.', model_id: 'requested', agent_type: 'chat' });
const now = new Date('2026-10-28T12:00:00Z');

function context() {
  const insertTask = vi.fn(async (t) => ({ id: 'task', ...t }));
  const ctx = { store: { getOrgSettings: async () => ({ newTasksEnabled: true }), listInstallations: async () => [], insertTask, insertEvent: vi.fn() }, loadAppSnapshot: vi.fn(async () => captureAppSnapshot(agent(), scope, now)), resolveModel: vi.fn(async () => 'allowed') } as unknown as WorkContext;
  return { ctx, insertTask };
}

describe('업무 앱 설정 연결', () => {
  afterEach(() => setLlmAdapterForTests(null));
  it.each([{ organization_id: 'other' }, { owner_id: 'other' }, { is_active: false }, { deleted_at: '2026-01-01' }, { agent_type: 'link' }])('쓸 수 없는 비서는 연결하지 않는다: %j', (patch) => {
    expect(() => captureAppSnapshot({ ...agent(), ...patch }, scope, now)).toThrow('사용할 수 있는 비서');
  });
  it('너무 긴 지침과 잘못된 선택은 작업 생성 전에 거부한다', async () => {
    expect(() => captureAppSnapshot({ ...agent(), system_prompt: 'a'.repeat(32001) }, scope, now)).toThrow('너무 깁니다');
    const { ctx, insertTask } = context();
    await expect(createTask(ctx, actor, { workflowKey: 'intake', title: '접수', agentId: '-'.repeat(36) })).rejects.toThrow('비서 선택');
    expect(insertTask).not.toHaveBeenCalled();
  });
  it('문서함 연결 자격은 공개 공식 비서의 검색 능력으로 제한한다', () => {
    const a = { ...agent(), tier: 'official' as const, is_published: true, capabilities: { doc_search: {} } };
    expect(captureAppSnapshot(a, scope, now).documentSearchEligible).toBe(true);
    expect(captureAppSnapshot({ ...a, capabilities: {} }, scope, now).documentSearchEligible).toBe(false);
    expect(captureAppSnapshot(agent(), scope, now).documentSearchEligible).toBe(false);
  });
  it('문서 범위는 지원하지 않는 업무나 비서에 연결하지 않는다', async () => {
    const { ctx, insertTask } = context();
    await expect(createTask(ctx, actor, { workflowKey: 'intake', title: '접수', agentId: id, documentScope: 'selected-agent' })).rejects.toThrow('공개 공식 비서');
    await expect(createTask(ctx, actor, { workflowKey: 'regulations', title: '규정', documentScope: 'selected-agent' })).rejects.toThrow('공개 공식 비서');
    expect(insertTask).not.toHaveBeenCalled();
  });
  it('지원되는 문서 범위는 작업 스냅샷에 함께 저장한다', async () => {
    const { ctx, insertTask } = context();
    ctx.loadAppSnapshot = async () => ({ ...captureAppSnapshot(agent(), scope, now), documentSearchEligible: true });
    ctx.store.getTemplateVersion = vi.fn(async () => ({ id: 'template', status: 'verified' } as never));
    await createTask(ctx, actor, { workflowKey: 'regulations', title: '규정', agentId: id, documentScope: 'selected-agent', templateVersionId: 'template' });
    expect(insertTask).toHaveBeenCalledWith(expect.objectContaining({ app_snapshot: expect.objectContaining({ documentScope: 'selected-agent', agentId: id }) }));
  });
  it('부서 비서는 가시 부서 범위를 적용한다', () => {
    const a = { ...agent(), tier: 'department' as const, department_id: 'other' };
    expect(() => captureAppSnapshot(a, scope, now)).toThrow();
    expect(captureAppSnapshot(a, { ...scope, visibleDepartmentIds: ['dept', 'other'] }, now).version).toBe(3);
  });
  it('원래 비서가 수정되어도 보존한 설정은 달라지지 않는다', () => {
    const a = agent(); const snapshot = captureAppSnapshot(a, scope, now);
    a.system_prompt = '바뀐 지침'; a.version = 4;
    expect(snapshot).toMatchObject({ version: 3, systemPrompt: '검토 의견은 개조식으로 작성하세요.', capturedAt: now.toISOString() });
  });
  it('작업 생성은 서버가 가져온 설정을 저장한다', async () => {
    const { ctx, insertTask } = context();
    await createTask(ctx, actor, { workflowKey: 'intake', title: '접수', agentId: id });
    expect(ctx.loadAppSnapshot).toHaveBeenCalledWith(actor, id);
    expect(insertTask).toHaveBeenCalledWith(expect.objectContaining({ agent_id: id, app_snapshot: expect.objectContaining({ version: 3 }) }));
  });
  it('접근 거절이면 작업도 생성하지 않는다', async () => {
    const { ctx, insertTask } = context();
    ctx.loadAppSnapshot = async () => { throw new Error('거절'); };
    await expect(createTask(ctx, actor, { workflowKey: 'intake', title: '접수', agentId: id })).rejects.toThrow('거절');
    expect(insertTask).not.toHaveBeenCalled();
  });
  it('기본 작업은 비서 조회 없이 생성하고 계산 업무는 연결을 거부한다', async () => {
    const { ctx } = context();
    await createTask(ctx, actor, { workflowKey: 'collection', title: '취합' });
    expect(ctx.loadAppSnapshot).not.toHaveBeenCalled();
    await expect(createTask(ctx, actor, { workflowKey: 'collection', title: '취합', agentId: id })).rejects.toThrow('프로그램으로 계산');
  });
  it('실행 시 요청 모델을 최신 기관 정책에 전달한다', async () => {
    const { ctx } = context();
    const task = { department_id: 'dept', app_snapshot: captureAppSnapshot(agent(), scope, now) } as WorkTaskRow;
    const options = await workModelOptions(ctx, task);
    expect(ctx.resolveModel).toHaveBeenCalledWith('dept', 'requested');
    expect(options).toMatchObject({ model: 'allowed', appInstruction: agent().system_prompt });
    await workModelOptions(ctx, { department_id: 'dept' } as WorkTaskRow);
    expect(ctx.resolveModel).toHaveBeenLastCalledWith('dept', undefined);
  });
  it('생성 모델에 지침을 전달하면서 출력 검증을 유지한다', async () => {
    const requests: LlmRequest[] = [];
    setLlmAdapterForTests({ async *stream() {}, async complete(req) { requests.push(req); return { text: JSON.stringify({ fields: { s1: { value: '초안', evidence: ['bad'] }, unknown: { value: '버릴 값', evidence: [] } }, missing: [] }), usage: { model: req.model, input_tokens: 1, output_tokens: 1 } }; } });
    const result = await llmGenerator.compose({ workflowName: '보고서', workflowPurpose: '초안', title: '보고', facts: [], fields: [], targetIds: ['s1'], sources: [], organizationName: null }, { model: 'allowed', appInstruction: '개조식 작성' });
    expect(requests[0].system).toContain('개조식 작성');
    expect(requests[0].system).toContain('절대 지어내지');
    expect(result.values.s1).toEqual({ value: '초안', evidenceIds: [] });
    expect(result.values.unknown).toBeUndefined();
  });
  it('화면 응답은 지침과 모델 설정 원문을 노출하지 않는다', () => {
    const task = { workflow_key: 'intake', app_snapshot: captureAppSnapshot(agent(), scope, now) } as WorkTaskRow;
    const dto = taskDto(task, { read: true, edit: true, review: true, download: true, isOwner: true, manageMembers: true, role: null });
    expect(dto.app).toMatchObject({ agentId: id, version: 3 });
    expect(JSON.stringify(dto)).not.toContain(agent().system_prompt);
    expect(JSON.stringify(dto)).not.toContain('requestedModel');
  });
});
