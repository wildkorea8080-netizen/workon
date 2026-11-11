import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 관리자 화면의 앱 일괄 실행(2026-11-10) — 관리 범위의 최근 묶음(앱·직원·줄 수·상태만, 입력·결과·파일 이름 없음),
 * 실행 중인 묶음 멈추기(사유 5자 이상·조건부·남은 줄 건너뜀·사본 지움·보안 로그·직원 메일), 관리자 아닌 요청 거절
 */
type Result = { data?: unknown; error?: { message: string } | null; count?: number };
const state = vi.hoisted(() => ({
  session: 'admin' as 'admin' | 'user' | null,
  results: {} as Record<string, Result[]>, calls: [] as unknown[][], security: [] as unknown[][], notices: [] as Record<string, unknown>[], removed: [] as string[],
}));
vi.mock('@/lib/auth', () => ({
  getServerAuthSession: async () => (state.session ? { user: { id: 'adm', role: state.session === 'user' ? 'USER' : 'ADMIN', departmentId: 'dept' } } : null),
  isAdminSession: (s: { user?: { role?: string } } | null) => s?.user?.role === 'ADMIN',
}));
vi.mock('@/lib/actor-scope', () => ({
  getActorScope: async () => ({ userId: 'adm', isAdmin: true, organizationId: 'org', departmentId: 'dept', visibleDepartmentIds: ['dept'], managedDepartmentIds: ['dept'], managesWholeOrganization: false }),
}));
vi.mock('@/lib/filter', () => ({ logSecurityEvent: async (...args: unknown[]) => { state.security.push(args); } }));
vi.mock('@/lib/apps/automation-notice', () => ({ notifyAutomationOwner: async (n: Record<string, unknown>) => { state.notices.push(n); } }));
vi.mock('@/lib/apps/batches', () => ({ removeBatchFiles: async (id: string) => { state.removed.push(id); } }));
vi.mock('@/lib/apps/schedule-health', () => ({ readScheduleHealth: async () => { throw new Error('skip'); } }));
vi.mock('@/lib/apps/webhook-switch', () => ({ readWebhookSwitch: async () => { throw new Error('skip'); }, readScheduleSwitch: async () => { throw new Error('skip'); }, webhookSwitchView: () => null }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const method of ['select', 'update', 'eq', 'in', 'is', 'not', 'order', 'limit', 'range']) {
        q[method] = (...args: unknown[]) => { state.calls.push([table, method, ...args]); return q; };
      }
      const next = () => Promise.resolve({ data: null, error: null, ...(state.results[table]?.shift() ?? {}) });
      q.maybeSingle = () => next();
      q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => next().then(resolve, reject);
      return q;
    },
  },
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/admin/app-automations/route';
import { PATCH } from '@/app/api/admin/app-automations/batches/[id]/route';
import { PERSONAL_APP_LABEL, adminBatchView } from '@/lib/apps/automation-admin-spec';
import { automationAdminNoticeMail } from '@/lib/mailer';

const BATCH = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const batchRow = (patch: Record<string, unknown> = {}) => ({
  id: BATCH, name: '11월 민원', status: 'running', total: 3, stop_reason: null, created_at: '2026-11-10T00:00:00Z', finished_at: null, department_id: 'dept',
  agent: { name: '민원 답변 앱', tier: 'department' }, owner: { full_name: '김주무관', deleted_at: null }, ...patch,
});
const items = [{ batch_id: BATCH, status: 'done' }, { batch_id: BATCH, status: 'failed' }, { batch_id: BATCH, status: 'pending' }];

beforeEach(() => { state.session = 'admin'; state.results = {}; state.calls = []; state.security = []; state.notices = []; state.removed = []; });
const patch = (body: unknown, id = BATCH) => PATCH(new NextRequest(`http://localhost/api/admin/app-automations/batches/${id}`, { method: 'PATCH', body: JSON.stringify(body) }), { params: { id } });

describe('보기(순수)', () => {
  it('줄 수·상태만 — 입력·결과·파일 칸이 없고 개인 앱 이름은 가린다', () => {
    const view = adminBatchView({ ...batchRow({ agent: { name: '내 비밀 앱', tier: 'personal' } }), inputs: { topic: '비밀 입력' }, file: { name: '비밀.hwpx' } } as never, '민원과', { done: 1, failed: 1, skipped: 0, pending: 1 });
    expect(view).toMatchObject({ appName: PERSONAL_APP_LABEL, ownerName: '김주무관', departmentName: '민원과', status: 'running', total: 3, done: 1, failed: 1, pending: 1 });
    const text = JSON.stringify(view);
    for (const secret of ['비밀 입력', '비밀.hwpx', '내 비밀 앱']) expect(text).not.toContain(secret);
  });
});

describe('목록', () => {
  it('관리 범위(기관 + 관리 부서)의 최근 묶음과 줄 상태 수', async () => {
    state.results = { app_batches: [{ data: [batchRow()] }], app_batch_items: [{ data: items, count: 3 }], departments: [{ data: [{ id: 'dept', name: '민원과' }] }] };
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.batches).toEqual([expect.objectContaining({ id: BATCH, name: '11월 민원', departmentName: '민원과', done: 1, failed: 1, pending: 1, skipped: 0 })]);
    expect(state.calls).toContainEqual(['app_batches', 'eq', 'organization_id', 'org']);
    expect(state.calls).toContainEqual(['app_batches', 'in', 'department_id', ['dept']]);
    expect(state.calls).toContainEqual(['app_batch_items', 'in', 'batch_id', [BATCH]]);
  });
  it('묶음을 못 읽으면 503', async () => {
    state.results = { app_batches: [{ error: { message: 'down' } }] };
    expect((await GET()).status).toBe(503);
  });
});

describe('멈추기', () => {
  it('관리자 아님 403·로그인 없음 401·틀린 할 일·짧은 사유·틀린 id 400', async () => {
    state.session = 'user';
    expect((await patch({ action: 'stop', reason: '비용 점검 중입니다' })).status).toBe(403);
    state.session = null;
    expect((await patch({ action: 'stop', reason: '비용 점검 중입니다' })).status).toBe(401);
    state.session = 'admin';
    expect((await patch({ action: 'pause', reason: '비용 점검 중입니다' })).status).toBe(400);
    expect((await patch({ action: 'stop', reason: '짧음' })).status).toBe(400);
    expect((await patch({ action: 'stop', reason: '비용 점검 중입니다' }, 'nope')).status).toBe(400);
  });
  it('범위 밖이면 404', async () => {
    state.results = { app_batches: [{ data: null }] };
    expect((await patch({ action: 'stop', reason: '비용 점검 중입니다' })).status).toBe(404);
    expect(state.security).toHaveLength(0);
  });
  it('실행 중인 묶음 — 조건부로 멈추고 남은 줄 건너뜀·사본 지움·보안 로그·직원 메일', async () => {
    state.results = {
      app_batches: [{ data: { id: BATCH, user_id: 'u1', agent_id: 'a1', status: 'running' } }, { data: [{ id: BATCH }] }, { data: batchRow({ status: 'stopped', stop_reason: '관리자가 멈췄습니다 — 비용 점검 중입니다' }) }],
      app_batch_items: [{ data: null }, { data: items, count: 3 }], departments: [{ data: { name: '민원과' } }],
    };
    const res = await patch({ action: 'stop', reason: '비용 점검 중입니다' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ status: 'stopped', stopReason: '관리자가 멈췄습니다 — 비용 점검 중입니다' });
    expect(state.calls).toContainEqual(['app_batches', 'update', expect.objectContaining({ status: 'stopped', stop_reason: '관리자가 멈췄습니다 — 비용 점검 중입니다' })]);
    expect(state.calls).toContainEqual(['app_batches', 'eq', 'status', 'running']);
    expect(state.calls).toContainEqual(['app_batch_items', 'update', expect.objectContaining({ status: 'skipped' })]);
    expect(state.calls).toContainEqual(['app_batch_items', 'eq', 'status', 'pending']);
    expect(state.removed).toEqual([BATCH]);
    expect(state.security[0]).toEqual(['dept', 'adm', 'app_batch_stopped', expect.objectContaining({ batch_id: BATCH, owner_user_id: 'u1', reason: '비용 점검 중입니다' }), 'medium']);
    expect(state.notices[0]).toMatchObject({ kind: 'batch_stopped', userId: 'u1', agentId: 'a1', targetId: BATCH, reason: '비용 점검 중입니다' });
  });
  it('이미 끝났거나 그 사이 끝난 묶음은 그대로 — 로그·메일·사본 지우기 없음', async () => {
    state.results = { app_batches: [{ data: { id: BATCH, user_id: 'u1', agent_id: 'a1', status: 'done' } }, { data: batchRow({ status: 'done' }) }], app_batch_items: [{ data: items, count: 3 }] };
    expect((await patch({ action: 'stop', reason: '비용 점검 중입니다' })).status).toBe(200);
    state.results = { app_batches: [{ data: { id: BATCH, user_id: 'u1', agent_id: 'a1', status: 'running' } }, { data: [] }, { data: batchRow({ status: 'done' }) }], app_batch_items: [{ data: items, count: 3 }] };
    expect((await patch({ action: 'stop', reason: '비용 점검 중입니다' })).status).toBe(200);
    expect(state.security).toHaveLength(0);
    expect(state.notices).toHaveLength(0);
    expect(state.removed).toHaveLength(0);
  });
});

describe('메일·연결', () => {
  it('직원 메일 — 무엇이·사유·실행 화면 단추, 관리자 이름 없음', () => {
    const mail = automationAdminNoticeMail({ kind: 'batch_stopped', appName: '민원 답변 앱', target: "일괄 실행 '11월 민원'", reason: '비용 점검 중입니다', at: new Date('2026-11-10T03:00:00Z'), url: 'https://x/apps/run?agent=a1' });
    expect(mail.subject).toContain('앱 일괄 실행을 멈췄습니다 — 민원 답변 앱');
    expect(mail.html).toContain('실행 화면 열기');
    expect(mail.html).toContain('비용 점검 중입니다');
    expect(mail.html).toContain('2026-11-10 12:00');
  });
  it('보안 로그 종류·감사 화면 이름·알림 대상·화면', () => {
    expect(readFileSync('src/lib/filter.ts', 'utf8')).toContain("| 'app_batch_stopped'");
    expect(readFileSync('src/app/api/admin/audit-logs/route.ts', 'utf8')).toContain("app_batch_stopped: '앱 일괄 실행 멈춤(관리자)'");
    const notice = readFileSync('src/lib/apps/automation-notice.ts', 'utf8');
    expect(notice).toContain("n.kind === 'batch_stopped' ? `/apps/run?agent=${encodeURIComponent(n.agentId)}`");
    expect(readFileSync('src/components/admin/AppAutomationAdmin.tsx', 'utf8')).toContain('/api/admin/app-automations/batches/');
  });
});
