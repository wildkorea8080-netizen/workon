import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const state = vi.hoisted(() => ({ session: null as unknown, actor: null as unknown, agent: null as unknown, calls: [] as unknown[], dbError: null as unknown, prefs: { favorite_agent_ids: ['old-agent'], favorite_workflow_keys: ['document-summary'] } }));
vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => state.session }));
vi.mock('@/lib/actor-scope', () => ({ getActorScope: async () => state.actor }));
vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {
  from(table: string) { const q = { select: () => q, eq: (k: string, v: unknown) => { state.calls.push([table, k, v]); return q; }, maybeSingle: async () => ({ data: table === 'users' ? state.prefs : state.agent, error: state.dbError }) }; return q; },
  rpc: async (name: string, args: unknown) => { state.calls.push([name, args]); return { data: { agentIds: [], workflowKeys: ['document-summary'] }, error: state.dbError }; },
} }));
import { GET, POST } from '@/app/api/apps/favorites/route';
import { favoriteAppIds, filterApps, appEntries } from '@/lib/apps/catalog';
const id = '11111111-1111-4111-8111-111111111111';
const rpcCalls = () => state.calls.filter((c) => Array.isArray(c) && c[0] === 'set_user_app_favorite');
const req = (body: unknown) => new NextRequest('http://localhost/api/apps/favorites', { method: 'POST', body: JSON.stringify(body) });
beforeEach(() => {
  state.session = { user: { id: 'me' } };
  state.actor = { userId: 'me', organizationId: 'org', departmentId: 'dept', visibleDepartmentIds: ['dept'], managedDepartmentIds: [], isAdmin: false, managesWholeOrganization: false };
  state.agent = { id, tier: 'personal', owner_id: 'me', organization_id: 'org', department_id: 'dept', is_active: true, is_published: false, deleted_at: null };
  state.calls = []; state.dbError = null;
});
describe('persistent app favorites API', () => {
  it('requires login for both handlers', async () => { state.session = null; expect((await GET()).status).toBe(401); expect((await POST(req({}))).status).toBe(401); expect(state.calls).toEqual([]); });
  it('reads only the session user and combines existing agent favorites', async () => { const r = await GET(); expect((await r.json()).data).toEqual({ agentIds: ['old-agent'], workflowKeys: ['document-summary'] }); expect(state.calls).toContainEqual(['users', 'id', 'me']); });
  it.each([null, {}, { appId: 'workflow:bad', favorite: true }, { appId: 'workflow:document-summary:x', favorite: true }, { appId: 'agent:invalid', favorite: true }, { appId: 'workflow:document-summary', favorite: 'true' }])('rejects invalid requests without saving: %j', async body => { expect((await POST(req(body))).status).toBeGreaterThanOrEqual(400); expect(rpcCalls()).toHaveLength(0); });
  it('does not accept a user id from the body', async () => { expect((await POST(req({ appId: 'workflow:document-summary', favorite: true, userId: 'other' }))).status).toBe(200); expect(rpcCalls()).toContainEqual(['set_user_app_favorite', { p_user_id: 'me', p_kind: 'workflow', p_key: 'document-summary', p_favorite: true }]); });
  it('requires an organization', async () => { state.actor = null; expect((await POST(req({ appId: 'workflow:document-summary', favorite: true }))).status).toBe(403); expect(rpcCalls()).toHaveLength(0); });
  it.each([{ organization_id: 'other' }, { owner_id: 'other' }, { is_active: false }, { deleted_at: 'now' }])('denies unavailable agents: %j', async patch => { state.agent = { ...(state.agent as object), ...patch }; expect((await POST(req({ appId: `agent:${id}`, favorite: true }))).status).toBe(403); expect(rpcCalls()).toHaveLength(0); });
  it('allows removing a stale agent favorite', async () => { state.agent = null; expect((await POST(req({ appId: `agent:${id}`, favorite: false }))).status).toBe(200); });
  it('fails visibly on storage errors', async () => { state.dbError = { code: 'connection' }; expect((await GET()).status).toBe(503); expect((await POST(req({ appId: 'workflow:document-summary', favorite: true }))).status).toBe(503); });
});
describe('category and favorite intersection', () => {
  it('keeps unknown or no-longer-visible favorite ids out of the visible list', () => { const ids = favoriteAppIds({ agentIds: ['missing'], workflowKeys: ['document-summary', 'removed'] }); const entries = appEntries([], [{ key: 'document-summary', name: '요약', purpose: '문서 요약', available: true, outputs: [] }, { key: 'meeting', name: '회의', purpose: '회의록', available: true, outputs: [] }] as never, true); expect(filterApps(entries, { query: '', kind: 'all', scope: 'all', category: '문서 작성·정리', favorites: ids }).map(e => e.id)).toEqual(['workflow:document-summary']); expect(filterApps(entries, { query: '', kind: 'all', scope: 'all', category: '회의', favorites: ids })).toEqual([]); });
});
