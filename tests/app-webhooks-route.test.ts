import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 앱 연동 API — 내 것만, 토큰 원문은 만든 응답에서 한 번만·DB에는 해시만, 대리 접근·파일 필수 앱·판 다름·상한 거절, 회수, 호출 라우트 연결 */
type Result = { data?: unknown; error?: { message: string } | null; count?: number | null };
const state = vi.hoisted(() => ({
  session: 'user' as 'user' | 'impersonating' | null, actor: true,
  results: {} as Record<string, Result[]>, calls: [] as unknown[][],
  handled: [] as unknown[], handlerResult: { status: 200, body: { ok: true }, headers: undefined as Record<string, string> | undefined } as { status: number; body: Record<string, unknown>; headers?: Record<string, string> }, handlerThrows: false,
}));
vi.mock('@/lib/auth', () => ({
  getServerAuthSession: async () => (state.session ? { user: { id: 'me', role: 'USER', departmentId: 'dept', ...(state.session === 'impersonating' ? { isImpersonating: true } : {}) } } : null),
}));
vi.mock('@/lib/actor-scope', () => ({
  getActorScope: async () => (state.actor ? { userId: 'me', isAdmin: false, organizationId: 'org', departmentId: 'dept', visibleDepartmentIds: ['dept'], managedDepartmentIds: [], managesWholeOrganization: false } : null),
}));
vi.mock('@/lib/logger', () => ({ logSystem: async () => {} }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const method of ['select', 'insert', 'update', 'eq', 'is', 'gt', 'order']) {
        q[method] = (...args: unknown[]) => { state.calls.push([table, method, ...args]); return q; };
      }
      const next = () => Promise.resolve({ data: null, error: null, count: null, ...(state.results[table]?.shift() ?? {}) });
      q.maybeSingle = () => { state.calls.push([table, 'maybeSingle']); return next(); };
      q.single = () => { state.calls.push([table, 'single']); return next(); };
      q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => next().then(resolve, reject);
      return q;
    },
  },
}));
vi.mock('@/lib/apps/webhooks', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/apps/webhooks')>();
  return {
    ...real,
    webhookDeps: () => ({}),
    handleWebhookCall: async (_deps: unknown, request: unknown) => { state.handled.push(request); if (state.handlerThrows) throw new Error('db'); return state.handlerResult; },
  };
});

import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/apps/webhooks/route';
import { DELETE } from '@/app/api/apps/webhooks/[id]/route';
import { POST as CALL } from '@/app/api/apps/webhook/route';
import { hashWebhookToken } from '@/lib/apps/webhooks';

beforeEach(() => {
  state.session = 'user'; state.actor = true; state.results = {}; state.calls = []; state.handled = []; state.handlerThrows = false;
  state.handlerResult = { status: 200, body: { ok: true }, headers: undefined };
});

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOOK = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const definition = { schemaVersion: 1, fields: [{ key: 'title', label: '제목', type: 'text', required: true }], output: 'paragraphs' };
const agentRow = (patch: Record<string, unknown> = {}) => ({
  id: AGENT, tier: 'department', department_id: 'dept', organization_id: 'org', visibility: 'organization', owner_id: 'me', created_by: 'me',
  is_active: true, is_published: true, deleted_at: null, approval_status: 'approved', version: 3, approval_version: null, name: '민원 앱', app_definition: definition, ...patch,
});
const hookRow = (patch: Record<string, unknown> = {}) => ({
  id: HOOK, agent_id: AGENT, app_version: 3, name: '민원 시스템', token_prefix: 'wo_wh_abcdef', status: 'active', expires_at: '2099-01-01T00:00:00Z',
  revoked_at: null, last_used_at: null, use_count: 0, last_status: null, last_error: null, last_conversation_id: null, created_at: '2026-11-03T00:00:00Z', ...patch,
});
const valid = { agent_id: AGENT, app_version: 3, name: '민원 시스템', expiry_days: 90 };
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/apps/webhooks', { method: 'POST', body: JSON.stringify(body) }));
const json = async (res: Response) => ({ status: res.status, body: await res.json() });

describe('GET·POST /api/apps/webhooks', () => {
  it('목록은 내 것만, 화면용 꼴(해시 없음)', async () => {
    state.results.app_webhooks = [{ data: [{ ...hookRow(), token_hash: 'f'.repeat(64), agent: { name: '민원 앱' } }] }];
    const { status, body } = await json(await GET());
    expect(status).toBe(200);
    expect(body.data[0]).toMatchObject({ id: HOOK, appName: '민원 앱', state: 'active' });
    expect(JSON.stringify(body)).not.toContain('f'.repeat(64));
    expect(state.calls).toContainEqual(['app_webhooks', 'eq', 'user_id', 'me']);
    state.session = null; expect((await GET()).status).toBe(401);
  });
  it('만들기: 토큰 원문은 응답에 한 번, DB에는 그 해시와 앞부분만 — 유효 기간은 서버가 정한다', async () => {
    state.results.agents = [{ data: agentRow() }];
    state.results.app_webhooks = [{ count: 4 }, { data: hookRow() }];
    const { status, body } = await json(await post(valid));
    expect(status).toBe(201);
    const token = body.data.token as string;
    expect(token).toMatch(/^wo_wh_[A-Za-z0-9_-]{43}$/);
    const inserted = state.calls.find(c => c[0] === 'app_webhooks' && c[1] === 'insert')?.[2] as Record<string, unknown>;
    expect(inserted).toMatchObject({ agent_id: AGENT, user_id: 'me', department_id: 'dept', organization_id: 'org', app_version: 3, name: '민원 시스템', status: 'active', token_hash: hashWebhookToken(token), token_prefix: token.slice(0, 12) });
    expect(JSON.stringify(inserted)).not.toContain(token);
    const days = (Date.parse(inserted.expires_at as string) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9); expect(days).toBeLessThan(90.1);
    // 상한은 쓸 수 있는(활성·만료 전) 연동만 센다
    expect(state.calls).toContainEqual(['app_webhooks', 'eq', 'status', 'active']);
    expect(state.calls.some(c => c[0] === 'app_webhooks' && c[1] === 'gt' && c[2] === 'expires_at')).toBe(true);
  });
  it('거절: 인증·소속·대리 접근, 꼴, 앱 없음/권한, 입력형 아님, 파일 필수, 판 다름, 상한 — 토큰을 만들지 않는다', async () => {
    state.session = null; expect((await post(valid)).status).toBe(401); state.session = 'user';
    state.actor = false; expect((await post(valid)).status).toBe(403); state.actor = true;
    state.session = 'impersonating'; expect(await json(await post(valid))).toMatchObject({ status: 403, body: { error: { message: expect.stringContaining('대리 접근') } } }); state.session = 'user';
    expect((await post({ ...valid, agent_id: 'x' })).status).toBe(400);
    expect((await post({ ...valid, expiry_days: 7 })).status).toBe(400);
    expect((await post({ ...valid, name: '' })).status).toBe(400);
    state.results.agents = [{ data: null }]; expect((await post(valid)).status).toBe(404);
    state.results.agents = [{ data: agentRow({ organization_id: 'other' }) }]; expect((await post(valid)).status).toBe(404);
    state.results.agents = [{ data: agentRow({ app_definition: null }) }]; expect((await post(valid)).status).toBe(400);
    state.results.agents = [{ data: agentRow({ app_definition: { ...definition, attachments: { required: true } } }) }];
    expect(await json(await post(valid))).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining('파일 첨부가 필수') } } });
    state.results.agents = [{ data: agentRow({ version: 4 }) }]; expect((await post(valid)).status).toBe(409);
    state.results.agents = [{ data: agentRow() }]; state.results.app_webhooks = [{ count: 5 }];
    expect(await json(await post(valid))).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining('5개까지') } } });
    expect(state.calls.filter(c => c[0] === 'app_webhooks' && c[1] === 'insert')).toHaveLength(0);
  });
});

describe('DELETE /api/apps/webhooks/[id] — 회수', () => {
  const del = (id: string) => DELETE(new NextRequest(`http://localhost/api/apps/webhooks/${id}`, { method: 'DELETE' }), { params: { id } });
  it('내 활성 연동만 회수 도장을 찍고(행은 남김) 현재 꼴을 돌려준다. 없으면 404', async () => {
    state.results.app_webhooks = [{ data: null }, { data: { ...hookRow({ status: 'revoked', revoked_at: '2026-11-03T01:00:00Z' }), agent: { name: '민원 앱' } } }];
    const { status, body } = await json(await del(HOOK));
    expect(status).toBe(200); expect(body.data.state).toBe('revoked');
    const update = state.calls.find(c => c[0] === 'app_webhooks' && c[1] === 'update')?.[2] as Record<string, unknown>;
    expect(update).toMatchObject({ status: 'revoked' }); expect(typeof update.revoked_at).toBe('string');
    expect(state.calls).toContainEqual(['app_webhooks', 'eq', 'user_id', 'me']);
    expect(state.calls).toContainEqual(['app_webhooks', 'eq', 'status', 'active']);
    state.results.app_webhooks = [{ data: null }, { data: null }];
    expect((await del(HOOK)).status).toBe(404);
    expect((await del('nope')).status).toBe(400);
    state.session = null; expect((await del(HOOK)).status).toBe(401);
  });
});

describe('POST /api/apps/webhook — 호출 라우트', () => {
  const callRoute = (headers: Record<string, string>, body = '{"inputs":{}}') => CALL(new Request('http://localhost/api/apps/webhook', { method: 'POST', headers, body }));
  it('Authorization·본문을 처리기에 그대로 넘기고 상태·머리글을 돌려준다', async () => {
    state.handlerResult = { status: 429, body: { ok: false, error: { message: '잠시' } }, headers: { 'Retry-After': '30' } };
    const res = await callRoute({ Authorization: 'Bearer wo_wh_x' });
    expect(res.status).toBe(429); expect(res.headers.get('Retry-After')).toBe('30');
    expect(state.handled[0]).toEqual({ authorization: 'Bearer wo_wh_x', bodyText: '{"inputs":{}}' });
  });
  it('Content-Length가 상한을 넘으면 읽기 전에 413, 처리기가 던지면 500(원문 없이)', async () => {
    expect((await callRoute({ 'Content-Length': String(70 * 1024) })).status).toBe(413);
    expect(state.handled).toHaveLength(0);
    state.handlerThrows = true;
    const res = await callRoute({ Authorization: 'Bearer wo_wh_x' });
    expect(res.status).toBe(500); expect(JSON.stringify(await res.json())).not.toContain('db');
  });
});
