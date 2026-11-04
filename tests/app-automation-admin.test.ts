import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 앱 예약·연동 관리자 통제(0050) — 관리 범위(기관 + 관리 부서)만, 입력값·결과·토큰·실패 원문은 내보내지 않음,
 * 개인 앱 이름 가림, 사유 5자 이상, 조건부 바꾸기(이미 처리된 것은 그대로)·바뀐 때만 보안 로그, 관리자 아닌 요청 거절
 */
type Result = { data?: unknown; error?: { message: string } | null };
const state = vi.hoisted(() => ({
  session: 'admin' as 'admin' | 'user' | 'impersonating' | null,
  managed: ['dept'] as string[],
  results: {} as Record<string, Result[]>, calls: [] as unknown[][], security: [] as unknown[][], healthScope: null as unknown, healthFails: false,
}));
vi.mock('@/lib/auth', () => ({
  getServerAuthSession: async () => (state.session ? { user: { id: 'adm', role: state.session === 'user' ? 'USER' : 'ADMIN', departmentId: 'dept', ...(state.session === 'impersonating' ? { isImpersonating: true } : {}) } } : null),
  isAdminSession: (s: { user?: { role?: string } } | null) => s?.user?.role === 'ADMIN',
}));
vi.mock('@/lib/actor-scope', () => ({
  getActorScope: async () => ({ userId: 'adm', isAdmin: true, organizationId: 'org', departmentId: 'dept', visibleDepartmentIds: ['dept'], managedDepartmentIds: state.managed, managesWholeOrganization: false }),
}));
vi.mock('@/lib/filter', () => ({ logSecurityEvent: async (...args: unknown[]) => { state.security.push(args); } }));
vi.mock('@/lib/apps/schedule-health', () => ({
  readScheduleHealth: async (_now: number, scope: unknown) => { state.healthScope = scope; if (state.healthFails) throw new Error('down'); return { runnerAlive: false, runnerLastRunAt: '2026-11-02T00:00:00Z', activeCount: 2, overdueCount: 1, stuckClaimCount: 0, problems: ['예약 실행기가 30분 넘게 불리지 않았습니다.'] }; },
}));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const method of ['select', 'update', 'eq', 'in', 'is', 'not', 'order', 'limit']) {
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
import { PATCH as PATCH_HOOK } from '@/app/api/admin/app-automations/webhooks/[id]/route';
import { PATCH as PATCH_SCHEDULE } from '@/app/api/admin/app-automations/schedules/[id]/route';
import {
  ADMIN_UNLOCKED_REASON, PERSONAL_APP_LABEL, adminScheduleView, adminWebhookView, parseAdminReason,
} from '@/lib/apps/automation-admin-spec';

const HOOK = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SCHEDULE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const now = Date.parse('2026-11-03T00:00:00Z');
const hookRow = (patch: Record<string, unknown> = {}) => ({
  id: HOOK, name: '민원 시스템', token_prefix: 'wo_wh_abcdef', status: 'active', expires_at: '2027-01-01T00:00:00Z', revoked_at: null, revoked_reason: null,
  last_used_at: null, use_count: 7, last_status: 'failed', created_at: '2026-11-01T00:00:00Z', department_id: 'dept',
  agent: { name: '민원 앱', tier: 'department' }, owner: { full_name: '김주무관', deleted_at: null }, ...patch,
});
const scheduleRow = (patch: Record<string, unknown> = {}) => ({
  id: SCHEDULE, frequency: 'weekly', weekday: 1, month_day: null, run_hour: 9, run_minute: 30, status: 'active', paused_reason: null, admin_paused_at: null,
  next_run_at: '2026-11-09T00:30:00Z', last_run_at: null, last_status: null, consecutive_failures: 0, run_count: 2, created_at: '2026-11-01T00:00:00Z',
  department_id: 'dept', agent: { name: '주간 보고 앱', tier: 'department' }, owner: { full_name: '이주무관', deleted_at: null }, ...patch,
});

beforeEach(() => { state.session = 'admin'; state.managed = ['dept']; state.results = {}; state.calls = []; state.security = []; state.healthScope = null; state.healthFails = false; });
const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const patchHook = (body: unknown, id = HOOK) => PATCH_HOOK(new NextRequest(`http://localhost/api/admin/app-automations/webhooks/${id}`, { method: 'PATCH', body: JSON.stringify(body) }), { params: { id } });
const patchSchedule = (body: unknown, id = SCHEDULE) => PATCH_SCHEDULE(new NextRequest(`http://localhost/api/admin/app-automations/schedules/${id}`, { method: 'PATCH', body: JSON.stringify(body) }), { params: { id } });

describe('규칙·보기(순수)', () => {
  it('사유는 5~200자, 제어·서식 글자는 지운다', () => {
    expect(parseAdminReason('  퇴사​ 예정자  ')).toEqual({ ok: true, reason: '퇴사 예정자' });
    for (const bad of [null, '', '짧음', 'x'.repeat(201), 3]) expect(parseAdminReason(bad).ok).toBe(false);
  });
  it('연동·예약 보기에 토큰 해시·입력값·실패 원문·결과 대화가 없고, 개인 앱 이름은 가리며 탈퇴한 직원은 표시한다', () => {
    const hook = adminWebhookView({ ...hookRow(), token_hash: 'f'.repeat(64), last_error: '비밀 입력 글', last_conversation_id: 'conv' } as never, '민원과', now);
    expect(hook).toMatchObject({ state: 'active', ownerName: '김주무관', departmentName: '민원과', appName: '민원 앱', useCount: 7, lastStatus: 'failed' });
    const text = JSON.stringify(hook);
    for (const secret of ['f'.repeat(64), '비밀 입력 글', 'conv']) expect(text).not.toContain(secret);
    expect(adminWebhookView(hookRow({ expires_at: '2026-11-02T00:00:00Z' }) as never, null, now).state).toBe('expired');
    const personal = adminWebhookView(hookRow({ agent: [{ name: '내 비밀 앱', tier: 'personal' }], owner: { full_name: '박주무관', deleted_at: '2026-11-02T00:00:00Z' } }) as never, null, now);
    expect(personal).toMatchObject({ appName: PERSONAL_APP_LABEL, ownerName: '박주무관(탈퇴)' });
    expect(JSON.stringify(personal)).not.toContain('내 비밀 앱');

    const schedule = adminScheduleView({ ...scheduleRow({ admin_paused_at: '2026-11-03T00:00:00Z', status: 'paused' }), inputs: { title: '비밀 입력' }, last_error: '오류 원문' } as never, '총무과', now);
    expect(schedule).toMatchObject({ description: '매주 월요일 09:30', adminPaused: true, status: 'paused', ownerName: '이주무관', departmentName: '총무과' });
    expect(JSON.stringify(schedule)).not.toMatch(/비밀 입력|오류 원문/);
    // 켜진 예약이 예정 시각보다 1시간 넘게 지났으면 지연, 멈춘 예약은 지연이 아니다
    expect(adminScheduleView(scheduleRow({ next_run_at: '2026-11-02T22:59:00Z' }) as never, null, now).overdue).toBe(true);
    expect(adminScheduleView(scheduleRow({ next_run_at: '2026-11-02T23:30:00Z' }) as never, null, now).overdue).toBe(false);
    expect(adminScheduleView(scheduleRow({ next_run_at: '2026-11-01T00:00:00Z', status: 'paused' }) as never, null, now).overdue).toBe(false);
  });
});

describe('GET /api/admin/app-automations', () => {
  it('기관과 관리 부서로 함께 거르고 부서 이름을 붙인다', async () => {
    state.results = { app_webhooks: [{ data: [hookRow()] }], app_schedules: [{ data: [scheduleRow()] }], departments: [{ data: [{ id: 'dept', name: '민원과' }] }] };
    const { status, body } = await json(await GET());
    expect(status).toBe(200);
    expect(body.data.webhooks[0]).toMatchObject({ id: HOOK, departmentName: '민원과' });
    expect(body.data.schedules[0]).toMatchObject({ id: SCHEDULE, departmentName: '민원과' });
    for (const table of ['app_webhooks', 'app_schedules']) {
      expect(state.calls).toContainEqual([table, 'eq', 'organization_id', 'org']);
      expect(state.calls).toContainEqual([table, 'in', 'department_id', ['dept']]);
    }
    expect(body.data.truncated).toBe(false);
    // 실행기 상태는 관리 범위로 센 숫자와 함께 실린다
    expect(body.data.runner).toMatchObject({ alive: false, overdueCount: 1, problems: ['예약 실행기가 30분 넘게 불리지 않았습니다.'] });
    expect(state.healthScope).toEqual({ organizationId: 'org', departmentIds: ['dept'] });
    state.healthFails = true;
    state.results = { app_webhooks: [{ data: [] }], app_schedules: [{ data: [] }], departments: [{ data: [] }] };
    const failed = await json(await GET());
    expect(failed.status).toBe(200); expect(failed.body.data.runner).toBeNull();
  });
  it('관리자가 아니면 403, 로그인 없으면 401, 관리 범위가 없으면 읽지 않고 403, 읽기 실패는 503', async () => {
    state.session = 'user'; expect((await GET()).status).toBe(403);
    state.session = null; expect((await GET()).status).toBe(401);
    state.session = 'admin'; state.managed = [];
    expect((await GET()).status).toBe(403); expect(state.calls).toHaveLength(0);
    state.managed = ['dept']; state.results = { app_webhooks: [{ error: { message: 'down' } }] };
    expect((await GET()).status).toBe(503);
  });
});

describe('PATCH 연동 회수', () => {
  it('범위 안 활성 연동을 사유와 함께 회수하고(조건부) 보안 로그를 남긴다 — 대리 접근도 기록', async () => {
    state.session = 'impersonating';
    state.results = {
      app_webhooks: [{ data: { id: HOOK, user_id: 'u1', agent_id: 'a1', status: 'active' } }, { data: [{ id: HOOK }] }, { data: hookRow({ status: 'revoked', revoked_at: '2026-11-03T00:00:00Z', revoked_reason: '관리자가 회수했습니다 — 퇴사 예정자' }) }],
      departments: [{ data: { name: '민원과' } }],
    };
    const { status, body } = await json(await patchHook({ action: 'revoke', reason: '퇴사 예정자' }));
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ state: 'revoked', revokedReason: '관리자가 회수했습니다 — 퇴사 예정자' });
    const update = state.calls.find(c => c[0] === 'app_webhooks' && c[1] === 'update')?.[2] as Record<string, unknown>;
    expect(update).toMatchObject({ status: 'revoked', revoked_reason: '관리자가 회수했습니다 — 퇴사 예정자' });
    expect(state.calls).toContainEqual(['app_webhooks', 'eq', 'status', 'active']);
    expect(state.calls).toContainEqual(['app_webhooks', 'in', 'department_id', ['dept']]);
    expect(state.security).toEqual([['dept', 'adm', 'app_webhook_revoked', { webhook_id: HOOK, owner_user_id: 'u1', agent_id: 'a1', reason: '퇴사 예정자', impersonating: true }, 'medium']]);
  });
  it('이미 회수된 연동은 바꾸지도 기록하지도 않고, 범위 밖이면 404, 사유·할 일·id가 틀리면 400, 관리자가 아니면 403', async () => {
    state.results = { app_webhooks: [{ data: { id: HOOK, user_id: 'u1', agent_id: 'a1', status: 'revoked' } }, { data: hookRow({ status: 'revoked', revoked_at: '2026-11-02T00:00:00Z' }) }] };
    expect((await patchHook({ action: 'revoke', reason: '퇴사 예정자' })).status).toBe(200);
    expect(state.calls.some(c => c[1] === 'update')).toBe(false); expect(state.security).toHaveLength(0);
    state.results = { app_webhooks: [{ data: null }] };
    expect((await patchHook({ action: 'revoke', reason: '퇴사 예정자' })).status).toBe(404);
    expect((await patchHook({ action: 'revoke', reason: '짧음' })).status).toBe(400);
    expect((await patchHook({ action: 'delete', reason: '퇴사 예정자' })).status).toBe(400);
    expect((await patchHook({ action: 'revoke', reason: '퇴사 예정자' }, 'nope')).status).toBe(400);
    state.session = 'user'; expect((await patchHook({ action: 'revoke', reason: '퇴사 예정자' })).status).toBe(403);
    state.session = null; expect((await patchHook({ action: 'revoke', reason: '퇴사 예정자' })).status).toBe(401);
  });
});

describe('PATCH 예약 멈춤·잠금 풀기', () => {
  it('멈춤은 잠금(admin_paused_at)과 사유를 걸고, 잠금 풀기는 예약을 멈춘 채로 두고 잠금만 푼다 — 둘 다 조건부·보안 로그', async () => {
    state.results = {
      app_schedules: [{ data: { id: SCHEDULE, user_id: 'u1', agent_id: 'a1', admin_paused_at: null } }, { data: [{ id: SCHEDULE }] }, { data: scheduleRow({ status: 'paused', admin_paused_at: '2026-11-03T00:00:00Z', paused_reason: '관리자가 멈췄습니다 — 비용 점검 중' }) }],
      departments: [{ data: { name: '총무과' } }],
    };
    const paused = await json(await patchSchedule({ action: 'pause', reason: '비용 점검 중' }));
    expect(paused).toMatchObject({ status: 200, body: { data: { adminPaused: true, status: 'paused' } } });
    const pausePatch = state.calls.find(c => c[0] === 'app_schedules' && c[1] === 'update')?.[2] as Record<string, unknown>;
    expect(pausePatch).toMatchObject({ status: 'paused', paused_reason: '관리자가 멈췄습니다 — 비용 점검 중' });
    expect(typeof pausePatch.admin_paused_at).toBe('string');
    expect(state.calls).toContainEqual(['app_schedules', 'is', 'admin_paused_at', null]);
    expect(state.security[0]).toEqual(['dept', 'adm', 'app_schedule_paused', expect.objectContaining({ schedule_id: SCHEDULE, owner_user_id: 'u1', reason: '비용 점검 중', impersonating: false }), 'medium']);

    state.calls = []; state.security = [];
    state.results = {
      app_schedules: [{ data: { id: SCHEDULE, user_id: 'u1', agent_id: 'a1', admin_paused_at: '2026-11-03T00:00:00Z' } }, { data: [{ id: SCHEDULE }] }, { data: scheduleRow({ status: 'paused', paused_reason: ADMIN_UNLOCKED_REASON }) }],
      departments: [{ data: { name: '총무과' } }],
    };
    const unlocked = await json(await patchSchedule({ action: 'unlock', reason: '점검 끝났습니다' }));
    expect(unlocked).toMatchObject({ status: 200, body: { data: { adminPaused: false, status: 'paused' } } });
    const unlockPatch = state.calls.find(c => c[0] === 'app_schedules' && c[1] === 'update')?.[2] as Record<string, unknown>;
    expect(unlockPatch).toEqual(expect.objectContaining({ admin_paused_at: null, paused_reason: ADMIN_UNLOCKED_REASON }));
    expect(unlockPatch).not.toHaveProperty('status');
    expect(state.security[0][2]).toBe('app_schedule_unlocked');
  });
  it('이미 잠긴 예약을 또 멈추거나 잠기지 않은 예약을 풀면 바꾸지 않는다. 범위 밖 404, 할 일·사유 틀리면 400', async () => {
    state.results = { app_schedules: [{ data: { id: SCHEDULE, user_id: 'u1', agent_id: 'a1', admin_paused_at: '2026-11-03T00:00:00Z' } }, { data: scheduleRow({ status: 'paused', admin_paused_at: '2026-11-03T00:00:00Z' }) }] };
    expect((await patchSchedule({ action: 'pause', reason: '비용 점검 중' })).status).toBe(200);
    state.results = { app_schedules: [{ data: { id: SCHEDULE, user_id: 'u1', agent_id: 'a1', admin_paused_at: null } }, { data: scheduleRow() }] };
    expect((await patchSchedule({ action: 'unlock', reason: '점검 끝났습니다' })).status).toBe(200);
    expect(state.calls.some(c => c[1] === 'update')).toBe(false); expect(state.security).toHaveLength(0);
    state.results = { app_schedules: [{ data: null }] };
    expect((await patchSchedule({ action: 'pause', reason: '비용 점검 중' })).status).toBe(404);
    expect((await patchSchedule({ action: 'resume', reason: '비용 점검 중' })).status).toBe(400);
    expect((await patchSchedule({ action: 'pause' })).status).toBe(400);
    state.session = 'user'; expect((await patchSchedule({ action: 'pause', reason: '비용 점검 중' })).status).toBe(403);
  });
});

describe('0050·화면 연결(원본 확인)', () => {
  it('칸 둘은 추가만이고 짝 CHECK가 있다 — 회수 사유는 회수된 연동에만, 관리자 잠금은 멈춘 예약에만', () => {
    const sql = readFileSync('supabase/migrations/0050_app_automation_admin.sql', 'utf8');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS revoked_reason text');
    expect(sql).toContain("status = 'revoked' AND char_length(revoked_reason) BETWEEN 1 AND 300");
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS admin_paused_at timestamptz');
    expect(sql).toContain("CHECK (admin_paused_at IS NULL OR status = 'paused')");
    expect(sql).not.toMatch(/DROP|DELETE FROM/i);
  });
  it('관리자 화면은 서버 모듈(DB 클라이언트)을 가져오지 않고 순수 규칙만 쓴다. 메뉴가 있다', () => {
    const ui = readFileSync('src/components/admin/AppAutomationAdmin.tsx', 'utf8');
    expect(ui).toContain("from '@/lib/apps/automation-admin-spec'");
    expect(ui).not.toMatch(/from '@\/lib\/apps\/automation-admin'|supabaseAdmin/);
    expect(readFileSync('src/components/admin/AdminNav.tsx', 'utf8')).toContain("href: '/admin/app-automations'");
  });
});
