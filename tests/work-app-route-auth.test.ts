import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const state = vi.hoisted(() => ({ session: null as unknown, scope: null as unknown, agent: null as unknown, department: { parent_id: null } as unknown, dbError: null as unknown, active: true, filters: [] as unknown[], inserted: [] as Record<string, unknown>[] }));
vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => state.session }));
vi.mock('@/lib/actor-scope', () => ({ getActorScope: async () => state.scope }));
vi.mock('@/lib/department-scope', () => ({ getVisibleDepartmentIds: async () => ['dept'], getAccessScope: async () => ({ organizationId: 'org', visibleDepartmentIds: ['dept'] }) }));
vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: { from(table: string) { const q = { select: () => q, eq: (key: string, value: unknown) => { state.filters.push([table, key, value]); return q; }, maybeSingle: async () => ({ data: table === 'agents' ? state.agent : state.department, error: state.dbError }) }; return q; } } }));
vi.mock('@/lib/work/store/supabase', () => ({ createSupabaseWorkStore: () => ({ isUserActive: async () => state.active, getOrgSettings: async () => ({ newTasksEnabled: true }), listInstallations: async () => [], insertTask: async (t: Record<string, unknown>) => { state.inserted.push(t); return { id: 'task', ...t }; }, insertEvent: async () => {}, getTemplateVersion: async () => ({ id: 'template', status: 'verified' }) }) }));
vi.mock('@/lib/work/services', async (original) => ({ ...await original<typeof import('@/lib/work/services')>(), getTaskDetail: async () => ({ task: { id: 'task' } }) }));
import { POST } from '@/app/api/work/tasks/route';
import { loadTask } from '@/lib/work/services';
import { defaultWorkContext } from '@/lib/work/server';
const agentId = '11111111-1111-4111-8111-111111111111';
const actor = { userId: 'user', organizationId: 'org', departmentId: 'dept', isAdmin: false, managedDepartmentIds: [] };
function request(extra: Record<string, unknown> = {}) { return new NextRequest('http://localhost/api/work/tasks', { method: 'POST', body: JSON.stringify({ workflowKey: 'intake', title: '시험', agentId, ...extra }) }); }
beforeEach(() => {
  state.session = { user: { id: 'user' } };
  state.scope = { ...actor, visibleDepartmentIds: ['dept'], managesWholeOrganization: false };
  state.agent = { id: agentId, tier: 'personal', department_id: 'dept', organization_id: 'org', owner_id: 'user', created_by: 'user', is_active: true, is_published: false, deleted_at: null, version: 2, name: '시험 비서', system_prompt: '작성 지침', model_id: null, agent_type: 'chat', capabilities: {} };
  state.department = { parent_id: null }; state.dbError = null; state.active = true; state.filters = []; state.inserted = [];
});
describe('실제 작업 POST 인증·설정 로더 경로(DB·세션만 대체)', () => {
  it('비로그인은 401', async () => { state.session = null; expect((await POST(request())).status).toBe(401); expect(state.inserted).toHaveLength(0); });
  it.each(['impersonation', 'inactive', 'no-scope'])('%s는 작업 생성 전 403', async (kind) => {
    if (kind === 'impersonation') state.session = { user: { id: 'user', isImpersonating: true } };
    if (kind === 'inactive') state.active = false;
    if (kind === 'no-scope') state.scope = null;
    expect((await POST(request())).status).toBe(403); expect(state.inserted).toHaveLength(0);
  });
  it.each([{ organization_id: 'other' }, { owner_id: 'other' }, { is_active: false }, { tier: 'department', department_id: 'other' }, { agent_type: 'link' }])('사용 불가 비서는 404: %j', async (patch) => {
    state.agent = { ...(state.agent as object), ...patch };
    expect((await POST(request())).status).toBe(404); expect(state.inserted).toHaveLength(0);
  });
  it('본문의 기관·주인·지침은 신뢰하지 않고 서버 설정만 저장한다', async () => {
    const response = await POST(request({ organizationId: 'attacker', ownerId: 'attacker', app_snapshot: { systemPrompt: '임의 지침' } }));
    expect(response.status).toBe(201);
    expect(state.inserted[0]).toMatchObject({ organization_id: 'org', owner_id: 'user', app_snapshot: { agentId, version: 2, systemPrompt: '작성 지침' } });
    expect(state.filters).toContainEqual(['agents', 'organization_id', 'org']);
  });
  it('부서 조회 실패·소속 소실은 범위를 넓히지 않는다', async () => {
    state.department = null;
    expect((await POST(request())).status).toBe(503); expect(state.inserted).toHaveLength(0);
  });
  it('DB 오류는 설정 저장 없이 503', async () => { state.dbError = { message: 'internal' }; expect((await POST(request())).status).toBe(503); expect(state.inserted).toHaveLength(0); });
  it('공개되지 않은 공식 비서는 일반 직원이 선택할 수 없다', async () => {
    state.agent = { ...(state.agent as object), tier: 'official', visibility: 'organization' };
    expect((await POST(request())).status).toBe(404);
  });
  it('문서함 옵션도 실제 서버의 공개·검색 능력 검사를 통과해야 한다', async () => {
    const denied = await POST(request({ workflowKey: 'reply', documentScope: 'selected-agent', templateVersionId: 'template' }));
    expect(denied.status).toBe(400);
    state.agent = { ...(state.agent as object), tier: 'official', visibility: 'organization', is_published: true, capabilities: { doc_search: {} } };
    expect((await POST(request({ workflowKey: 'reply', documentScope: 'selected-agent', templateVersionId: 'template' }))).status).toBe(201);
    expect(state.inserted[0].app_snapshot).toMatchObject({ documentScope: 'selected-agent' });
  });
  it('비서 사용 가능 여부와 별개로 남의 비공유 작업은 관리자도 읽지 못한다', async () => {
    const ctx = defaultWorkContext();
    ctx.store.getTask = async () => ({ id: agentId, organization_id: 'org', owner_id: 'other', status: 'draft' } as never);
    ctx.store.getMembers = async () => [];
    await expect(loadTask(ctx, { ...actor, isAdmin: true, managedDepartmentIds: ['dept'] }, agentId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('공유받은 viewer는 조회만 가능하고 수정은 거절한다', async () => {
    const ctx = defaultWorkContext();
    ctx.store.getTask = async () => ({ id: agentId, organization_id: 'org', owner_id: 'other', status: 'draft' } as never);
    ctx.store.getMembers = async () => [{ task_id: agentId, user_id: 'user', role: 'viewer' }];
    expect((await loadTask(ctx, actor, agentId)).access.read).toBe(true);
    await expect(loadTask(ctx, actor, agentId, 'edit')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('직접 설정 로더도 비서 사용 권한을 검사한다', async () => {
    state.agent = { ...(state.agent as object), owner_id: 'other' };
    await expect(defaultWorkContext().loadAppSnapshot!(actor, agentId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
