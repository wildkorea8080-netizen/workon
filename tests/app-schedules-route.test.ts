import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 앱 예약 API — 내 예약만, 지금 앱 판 기준 입력 검사, 파일 필수 앱·상한·판 다름 거절 */
type Result = { data?: unknown; error?: { message: string } | null; count?: number | null };
const state = vi.hoisted(() => ({ session: true, actor: true, results: {} as Record<string, Result[]>, calls: [] as unknown[][] }));
vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => (state.session ? { user: { id: 'me', role: 'USER', departmentId: 'dept' } } : null) }));
vi.mock('@/lib/actor-scope', () => ({
  getActorScope: async () => (state.actor ? { userId: 'me', isAdmin: false, organizationId: 'org', departmentId: 'dept', visibleDepartmentIds: ['dept'], managedDepartmentIds: [], managesWholeOrganization: false } : null),
}));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const method of ['select', 'insert', 'update', 'delete', 'eq', 'is', 'lte', 'or', 'order', 'limit']) {
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

import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/apps/schedules/route';
import { DELETE, PATCH } from '@/app/api/apps/schedules/[id]/route';
import { PAUSED_BY_USER } from '@/lib/apps/schedule-spec';

beforeEach(() => { state.session = true; state.actor = true; state.results = {}; state.calls = []; });

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SCHEDULE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const definition = { schemaVersion: 1, fields: [{ key: 'title', label: '제목', type: 'text', required: true }], output: 'paragraphs' };
const agentRow = (patch: Record<string, unknown> = {}) => ({
  id: AGENT, tier: 'department', department_id: 'dept', organization_id: 'org', visibility: 'organization', owner_id: 'me', created_by: 'me',
  is_active: true, is_published: true, deleted_at: null, approval_status: 'approved', version: 3, approval_version: null, name: '주간 보고 앱', app_definition: definition, ...patch,
});
const scheduleRow = (patch: Record<string, unknown> = {}) => ({
  id: SCHEDULE, agent_id: AGENT, app_version: 3, inputs: { title: '주간 보고' }, frequency: 'daily', weekday: null, month_day: null, run_hour: 9, run_minute: 0,
  status: 'active', paused_reason: null, next_run_at: '2026-11-04T00:00:00.000Z', last_run_at: null, last_status: null, last_error: null, last_conversation_id: null,
  consecutive_failures: 0, run_count: 0, created_at: '2026-11-01T00:00:00.000Z', ...patch,
});
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/apps/schedules', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }));
const patchReq = (id: string, body: unknown) => PATCH(new NextRequest(`http://localhost/api/apps/schedules/${id}`, { method: 'PATCH', body: JSON.stringify(body) }), { params: { id } });
const valid = { agent_id: AGENT, app_version: 3, inputs: { title: '주간 보고' }, frequency: 'daily', hour: 9, minute: 0 };
const json = async (res: Response) => ({ status: res.status, body: await res.json() });

describe('GET /api/apps/schedules', () => {
  it('로그인한 사람의 예약만 조회하고(user_id 조건) 화면용 꼴로 돌려준다', async () => {
    state.results.app_schedules = [{ data: [{ ...scheduleRow(), agent: { name: '주간 보고 앱' } }] }];
    const { status, body } = await json(await GET());
    expect(status).toBe(200);
    expect(body.data[0]).toMatchObject({ id: SCHEDULE, appName: '주간 보고 앱', description: '매일 09:00', status: 'active' });
    expect(state.calls).toContainEqual(['app_schedules', 'eq', 'user_id', 'me']);
    state.session = false;
    expect((await GET()).status).toBe(401);
  });
});

describe('POST /api/apps/schedules', () => {
  it('지금 앱 판 기준으로 입력을 검사해 저장하고 다음 실행 시각을 함께 넣는다', async () => {
    state.results.agents = [{ data: agentRow() }];
    state.results.app_schedules = [{ count: 2 }, { data: scheduleRow() }];
    const { status, body } = await json(await post(valid));
    expect(status).toBe(201);
    expect(body.data).toMatchObject({ appName: '주간 보고 앱', description: '매일 09:00' });
    const inserted = state.calls.find(c => c[0] === 'app_schedules' && c[1] === 'insert')?.[2] as Record<string, unknown>;
    expect(inserted).toMatchObject({ agent_id: AGENT, user_id: 'me', department_id: 'dept', organization_id: 'org', app_version: 3, inputs: { title: '주간 보고' }, frequency: 'daily', run_hour: 9, run_minute: 0, status: 'active' });
    expect(Date.parse(inserted.next_run_at as string)).toBeGreaterThan(Date.now());
    expect(state.calls).toContainEqual(['agents', 'is', 'deleted_at', null]);
  });
  it('거절: 인증·소속 없음, 본문·주기 틀림, 앱 없음/권한 없음, 입력형 아님, 파일 필수 앱, 판 다름, 필수 입력 빠짐, 상한', async () => {
    state.session = false; expect((await post(valid)).status).toBe(401); state.session = true;
    state.actor = false; expect((await post(valid)).status).toBe(403); state.actor = true;
    expect((await post({ ...valid, agent_id: 'x' })).status).toBe(400);
    expect((await post({ ...valid, frequency: 'hourly' })).status).toBe(400);
    expect((await post({ ...valid, minute: 15 })).status).toBe(400);
    expect(state.calls.filter(c => c[0] === 'agents')).toHaveLength(0); // 꼴 검사에서 거절되면 DB를 안 본다

    state.results.agents = [{ data: null }]; expect((await post(valid)).status).toBe(404);
    state.results.agents = [{ data: agentRow({ organization_id: 'other' }) }]; expect((await post(valid)).status).toBe(404);
    state.results.agents = [{ data: agentRow({ app_definition: null }) }];
    expect(await json(await post(valid))).toMatchObject({ status: 400, body: { error: { message: '입력형 앱만 예약할 수 있습니다.' } } });
    state.results.agents = [{ data: agentRow({ app_definition: { ...definition, attachments: { required: true } } }) }];
    expect(await json(await post(valid))).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining('파일 첨부가 필수') } } });
    state.results.agents = [{ data: agentRow({ version: 4 }) }];
    expect(await json(await post(valid))).toMatchObject({ status: 409, body: { error: { message: expect.stringContaining('앱 설정이 변경') } } });
    state.results.agents = [{ data: agentRow() }];
    expect((await post({ ...valid, inputs: {} })).status).toBe(400);
    state.results.agents = [{ data: agentRow() }]; state.results.app_schedules = [{ count: 5 }];
    expect(await json(await post(valid))).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining('5개까지') } } });
    expect(state.calls.filter(c => c[0] === 'app_schedules' && c[1] === 'insert')).toHaveLength(0);
  });
});

describe('PATCH·DELETE /api/apps/schedules/[id]', () => {
  it('멈추기는 이유를 적고, 다시 켜기는 다음 시각을 지금부터 다시 세고 실패 수·차지를 지운다 — 내 예약만', async () => {
    state.results.app_schedules = [{ data: { ...scheduleRow(), agent: { name: '앱' } } }, { data: scheduleRow({ status: 'paused', paused_reason: PAUSED_BY_USER }) }];
    const paused = await json(await patchReq(SCHEDULE, { action: 'pause' }));
    expect(paused.status).toBe(200); expect(paused.body.data.status).toBe('paused');
    const pausePatch = state.calls.find(c => c[0] === 'app_schedules' && c[1] === 'update')?.[2] as Record<string, unknown>;
    expect(pausePatch).toMatchObject({ status: 'paused', paused_reason: PAUSED_BY_USER });
    expect(state.calls.filter(c => c[0] === 'app_schedules' && c[1] === 'eq' && c[2] === 'user_id')).toHaveLength(2);

    state.calls = [];
    state.results.app_schedules = [{ data: { ...scheduleRow({ status: 'paused', consecutive_failures: 3 }), agent: { name: '앱' } } }, { data: scheduleRow() }];
    const resumed = await json(await patchReq(SCHEDULE, { action: 'resume' }));
    expect(resumed.status).toBe(200);
    const resumePatch = state.calls.find(c => c[0] === 'app_schedules' && c[1] === 'update')?.[2] as Record<string, unknown>;
    expect(resumePatch).toMatchObject({ status: 'active', paused_reason: null, consecutive_failures: 0, claimed_at: null });
    expect(Date.parse(resumePatch.next_run_at as string)).toBeGreaterThan(Date.now());

    expect((await patchReq(SCHEDULE, { action: 'run' })).status).toBe(400);
    expect((await patchReq('nope', { action: 'pause' })).status).toBe(400);
    state.results.app_schedules = [{ data: null }];
    expect((await patchReq(SCHEDULE, { action: 'pause' })).status).toBe(404);
  });
  it('지우기는 내 것만 지우고 없으면 404', async () => {
    const req = new NextRequest(`http://localhost/api/apps/schedules/${SCHEDULE}`, { method: 'DELETE' });
    state.results.app_schedules = [{ data: [{ id: SCHEDULE }] }];
    expect((await DELETE(req, { params: { id: SCHEDULE } })).status).toBe(200);
    expect(state.calls).toContainEqual(['app_schedules', 'eq', 'user_id', 'me']);
    state.results.app_schedules = [{ data: [] }];
    expect((await DELETE(req, { params: { id: SCHEDULE } })).status).toBe(404);
    state.session = false;
    expect((await DELETE(req, { params: { id: SCHEDULE } })).status).toBe(401);
  });
});
