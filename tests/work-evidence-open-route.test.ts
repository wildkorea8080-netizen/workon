import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ session: null as unknown, scope: null as unknown, doc: null as unknown, agent: null as unknown, ctx: null as unknown, signs: [] as unknown[], filters: [] as unknown[], storageError: false }));
vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => state.session }));
vi.mock('@/lib/actor-scope', () => ({ getActorScope: async () => state.scope }));
vi.mock('@/lib/agent-store', () => ({ loadAgentAccess: async () => state.agent }));
vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: { from: () => { const q = { select: () => q, eq: (k: string, v: unknown) => { state.filters.push([k, v]); return q; }, maybeSingle: async () => ({ data: state.doc, error: null }) }; return q; }, storage: { from: () => ({ createSignedUrl: async (p: string, ttl: number) => { state.signs.push([p, ttl]); return { data: { signedUrl: 'https://storage.example.test/temporary' }, error: state.storageError ? {} : null }; } }) } } }));
vi.mock('@/lib/work/server', async (original) => ({ ...await original<typeof import('@/lib/work/server')>(), defaultWorkContext: () => state.ctx }));
import { GET } from '@/app/api/work/tasks/[id]/evidence/[documentId]/open/route';
const taskId = '11111111-1111-4111-8111-111111111111';
const documentId = '22222222-2222-4222-8222-222222222222';
const request = () => GET(new Request('http://localhost'), { params: { id: taskId, documentId } });
beforeEach(() => {
  state.session = { user: { id: 'user' } };
  state.scope = { userId: 'user', departmentId: 'dept', organizationId: 'org', isAdmin: false, managedDepartmentIds: [], visibleDepartmentIds: ['dept'], managesWholeOrganization: false };
  state.doc = { id: documentId, agent_id: 'agent', organization_id: 'org', department_id: 'dept', visibility: 'organization', storage_path: 'private/path' };
  state.agent = { id: 'agent', tier: 'official', organization_id: 'org', department_id: 'dept', visibility: 'organization', is_published: true, is_active: true, deleted_at: null };
  state.ctx = { store: { isUserActive: async () => true, getTask: async () => ({ id: taskId, organization_id: 'org', owner_id: 'user', status: 'draft', current_document_version_id: 'version', app_snapshot: { agentId: 'agent' } }), getMembers: async () => [], getVersion: async () => ({ task_id: taskId, content: { appEvidence: [{ id: 'rag:123', name: '원문', text: '자료', documentId }] } }) } };
  state.signs = []; state.filters = []; state.storageError = false;
});
describe('원문 열기 실제 GET 경로(DB·세션만 대체)', () => {
  it('권한 확인 뒤 60초 서명 주소로 이동하고 캐시를 막는다', async () => {
    const response = await request();
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://storage.example.test/temporary');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(state.signs).toEqual([['private/path', 60]]);
    expect(state.filters).toContainEqual(['organization_id', 'org']);
  });
  it('로그인이 없으면 서명하지 않는다', async () => { state.session = null; expect((await request()).status).toBe(401); expect(state.signs).toHaveLength(0); });
  it('대리 접근은 허용하지 않는다', async () => { state.session = { user: { id: 'user', isImpersonating: true } }; expect((await request()).status).toBe(403); expect(state.signs).toHaveLength(0); });
  it.each([{ organization_id: 'other' }, { visibility: 'department', department_id: 'other' }, { agent_id: 'other' }, { storage_path: null }])('원문 현재 권한이 없으면 404: %j', async (patch) => {
    state.doc = { ...(state.doc as object), ...patch };
    expect((await request()).status).toBe(404); expect(state.signs).toHaveLength(0);
  });
  it.each([{ is_active: false }, { is_published: false }, { deleted_at: '2026-10-29' }])('비서 사용 권한이 사라지면 404: %j', async (patch) => {
    state.agent = { ...(state.agent as object), ...patch };
    expect((await request()).status).toBe(404); expect(state.signs).toHaveLength(0);
  });
  it('스토리지 실패는 내부 경로를 반환하지 않는다', async () => {
    state.storageError = true;
    const response = await request(); expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('private/path');
  });
});
