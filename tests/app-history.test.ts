import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { historySummary, encodeHistoryCursor, decodeHistoryCursor } from '@/lib/apps/history';
const id = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const definition = { schemaVersion: 1, fields: [{ key: 'source', label: '자료', type: 'text', required: true }], output: 'bullets', steps: [{ name: '정리', instruction: '정리' }, { name: '작성', instruction: '작성' }] };
function row() { return { id, agent_id: agentId, title: '실행', created_at: '2026-10-31T00:00:00.123456+00:00', agent: { id: agentId, name: '시험 앱', version: 3, app_definition: definition, capabilities: {}, tier: 'personal', owner_id: 'me', organization_id: 'org', department_id: 'dept', is_active: true, deleted_at: null }, messages: [{ id: 'message', content: '중단된 실행', agent_version: 3, source_references: { app_inputs: { source: 'private-input' }, app_steps: [{ name: '정리', status: 'completed', output: 'private-output' }, { name: '작성', status: 'failed' }] } }] }; }
const state = vi.hoisted(() => ({ session: true, actor: true, rows: [] as unknown[], calls: [] as unknown[], error: false }));
vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => state.session ? { user: { id: 'me' } } : null }));
vi.mock('@/lib/actor-scope', () => ({ getActorScope: async () => state.actor ? { userId: 'me', organizationId: 'org', departmentId: 'dept', visibleDepartmentIds: ['dept'], managedDepartmentIds: [] } : null }));
vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: { from(table: string) { const q: Record<string, unknown> = {}; for (const method of ['select','eq','not','order','limit','or']) q[method] = (...args: unknown[]) => { state.calls.push([table, method, ...args]); return q; }; q.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: state.rows, error: state.error ? { message: 'db unavailable' } : null }).then(resolve); return q; } } }));
import { GET } from '@/app/api/apps/history/route';
const request = (query = '') => new NextRequest(`http://localhost/api/apps/history${query}`);
beforeEach(() => { state.session = true; state.actor = true; state.rows = [row()]; state.calls = []; state.error = false; });

describe('app history summaries and cursors', () => {
  it('keeps safe summary fields and checks resume eligibility', () => { const result = historySummary(row()); expect(result.status).toBe('interrupted'); expect(result.canResume).toBe(true); expect(JSON.stringify(result)).not.toContain('private-input'); expect(JSON.stringify(result)).not.toContain('private-output'); expect(result.steps[0]).not.toHaveProperty('output'); });
  it('does not claim pending rows are running or completed', () => { const r = row(); r.messages = []; expect(historySummary(r).status).toBe('no_response'); });
  it('disables resume after a version or capability change', () => { const r = row(); r.agent.version = 4; expect(historySummary(r).canResume).toBe(false); r.agent.version = 3; r.agent.capabilities = { doc_search: {} }; expect(historySummary(r).canResume).toBe(false); });
  it('bounds text previews', () => { const r = row(); r.messages[0].content = 'x'.repeat(1000); expect(historySummary(r).preview).toHaveLength(160); });
  it('distinguishes a saved answer from an uncertain stage record', () => { const r = row(); r.messages[0].source_references.app_steps = r.messages[0].source_references.app_steps.map(step => ({ ...step, status: 'completed', output: '결과' })); expect(historySummary(r).status).toBe('saved'); expect(historySummary(r).canResume).toBe(false); r.messages[0].source_references.app_steps[1].status = 'running'; expect(historySummary(r).status).toBe('uncertain'); });
  it('roundtrips full database timestamp precision', () => { const at = row().created_at; expect(decodeHistoryCursor(encodeHistoryCursor(at,id))).toEqual({ at, id }); });
  it.each(['not-json', 'x'.repeat(513), encodeHistoryCursor('2026-02-31T00:00:00Z',id), encodeHistoryCursor('2026-10-31T00:00:00Z),id.gt.other',id), encodeHistoryCursor('2026-10-31T00:00:00Z','bad')])('rejects malformed cursors %s', cursor => { expect(decodeHistoryCursor(cursor)).toBeNull(); });
});
describe('app history API access and pagination', () => {
  it('requires login and a known organization', async () => { state.session = false; expect((await GET(request())).status).toBe(401); state.session = true; state.actor = false; expect((await GET(request())).status).toBe(403); expect(state.calls).toEqual([]); });
  it('derives owner/org from the session and omits inaccessible agents', async () => { const other = row(); other.agent.owner_id = 'other'; state.rows = [row(),other]; const r = await GET(request('?userId=other')); expect((await r.json()).data.items).toHaveLength(1); expect(state.calls).toContainEqual(['conversations','eq','user_id','me']); expect(state.calls).toContainEqual(['conversations','eq','agent.organization_id','org']); });
  it('bounds both conversations and embedded assistant responses', async () => { await GET(request()); expect(state.calls).toContainEqual(['conversations','limit',21]); expect(state.calls).toContainEqual(['conversations','limit',1,{ referencedTable: 'messages' }]); expect(state.calls).toContainEqual(['conversations','eq','messages.role','assistant']); });
  it('rejects invalid query data before querying the database', async () => { expect((await GET(request('?agent=../other'))).status).toBe(400); expect((await GET(request('?cursor=unsafe'))).status).toBe(400); expect(state.calls).toEqual([]); });
  it('uses the last scanned row as the cursor, even when access filters hide rows', async () => {
    const rows = Array.from({ length: 21 }, (_, index) => ({ ...row(), id: `11111111-1111-4111-8111-${(21-index).toString(16).padStart(12,'0')}` }));
    rows[19].agent.owner_id = 'other'; state.rows = rows;
    const r = await GET(request()); const body = await r.json(); expect(body.data.items).toHaveLength(19);
    expect(decodeHistoryCursor(body.data.nextCursor)).toEqual({ at: rows[19].created_at, id: rows[19].id });
    expect(body.data.items.some((item: {id: string}) => item.id === rows[19].id)).toBe(false);
  });
  it('applies a validated app filter and cursor together', async () => { const cursor = encodeHistoryCursor(row().created_at,id); await GET(request(`?agent=${agentId}&cursor=${cursor}`)); expect(state.calls).toContainEqual(['conversations','eq','agent_id',agentId]); expect(state.calls).toContainEqual(['conversations','or',`created_at.lt.${row().created_at},and(created_at.eq.${row().created_at},id.lt.${id})`]); });
  it('returns an actionable storage error', async () => { state.error = true; expect((await GET(request())).status).toBe(503); });
});

describe('history keeps the chosen branch name without outputs', () => {
  it('passes branch through, bounded, and drops it when absent', () => {
    const r = row(); (r.messages[0].source_references as Record<string, unknown>).app_steps = [{ name: '정리', status: 'completed', output: 'private-output', branch: '요구 정리' }, { name: '작성', status: 'failed' }];
    const result = historySummary(r);
    expect(result.steps[0]).toEqual({ name: '정리', status: 'completed', branch: '요구 정리' });
    expect(result.steps[1]).not.toHaveProperty('branch');
    expect(JSON.stringify(result)).not.toContain('private-output');
  });
});
