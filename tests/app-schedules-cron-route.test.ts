import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 앱 예약 실행기 라우트의 자격 — 업무 작업자 비밀값(pg_cron이 Vault로 싣는 값) 또는 CRON_SECRET, 둘 다 없으면 503 */
const state = vi.hoisted(() => ({ worker: 'w'.repeat(64) as string | undefined, cron: 'c'.repeat(40) as string | undefined, runs: 0, beats: 0, dispatches: 0, batches: 0, references: 0, budget: 0 }));
vi.mock('@/lib/config', () => ({
  get WORK_WORKER_SECRET() { return state.worker; },
  get CRON_SECRET() { return state.cron; },
}));
vi.mock('@/lib/apps/schedules', () => ({
  scheduleDeps: () => ({}),
  runDueSchedules: async () => { state.runs++; return { checked: 0, completed: 0, failed: 0, paused: 0, skipped: 0, partial: false }; },
}));

vi.mock('@/lib/apps/schedule-health', () => ({ recordRunnerHeartbeat: async () => { state.beats++; } }));
// 앱 결과 보내기(0076) — 예약 실행과 나란히 돈다. 자격이 없으면 이것도 돌지 않아야 한다
vi.mock('@/lib/apps/batches', () => ({ batchDeps: () => ({}), runDueBatchItems: async () => { state.batches++; return { ran: 0, done: 0, failed: 0, retried: 0, stopped: 0 }; } }));
vi.mock('@/lib/apps/outbound/deliver', () => ({ outboundDeps: () => ({}), dispatchDueDeliveries: async () => { state.dispatches++; return { claimed: 0, sent: 0, retried: 0, gaveUp: 0 }; } }));
vi.mock('@/lib/apps/outbound/notices', () => ({ runOutboundNotices: async () => ({ failureMails: 0, approvalMails: 0 }) }));
// 문서 참조 색인 자동 채우기(2026-11-12) — 같은 차례에 나란히
vi.mock('@/lib/document-references', () => ({ autoIndexReferences: async () => { state.references++; return { indexed: 0, skipped: 0, deferred: 0 }; } }));
vi.mock('@/lib/document-references-db', () => ({ autoIndexDeps: () => ({}) }));
// 예산 알림 빠른 확인(2026-11-12) — 15분 차례에만, 자격이 없으면 돌지 않음
vi.mock('@/lib/budget-alerts', () => ({ budgetAlertDeps: () => ({}), quickBudgetAlertDue: () => true, runBudgetAlerts: async () => { state.budget++; return { checked: 0, sent: 0, failed: 0, skipped: null, partial: false }; } }));

import { GET, POST } from '@/app/api/cron/app-schedules/route';

const call = (method: 'GET' | 'POST', auth?: string) =>
  (method === 'GET' ? GET : POST)(new Request('http://localhost/api/cron/app-schedules', { method, headers: auth ? { Authorization: auth } : {} }));

beforeEach(() => { state.worker = 'w'.repeat(64); state.cron = 'c'.repeat(40); state.runs = 0; state.beats = 0; state.dispatches = 0; state.batches = 0; state.references = 0; state.budget = 0; });

describe('/api/cron/app-schedules 자격', () => {
  it('업무 작업자 비밀값·CRON_SECRET 어느 쪽이든 실행하고, GET·POST가 같다', async () => {
    expect((await call('POST', `Bearer ${'w'.repeat(64)}`)).status).toBe(200);
    expect((await call('GET', `Bearer ${'c'.repeat(40)}`)).status).toBe(200);
    expect(state.runs).toBe(2);
    expect(state.dispatches).toBe(2);
    expect(state.batches).toBe(2);
    expect(state.references).toBe(2);
    expect(state.budget).toBe(2);
    expect(state.beats).toBe(2);
  });
  it('비밀값이 없거나 틀리거나 꼴이 다르면 401(머리글 앞뒤 공백은 Headers가 지운다)이고 실행하지 않는다', async () => {
    for (const auth of [undefined, 'Bearer wrong', `bearer ${'w'.repeat(64)}`, 'w'.repeat(64)]) {
      expect((await call('POST', auth)).status).toBe(401);
    }
    expect(state.beats).toBe(0);
    expect(state.dispatches).toBe(0);
    expect(state.batches).toBe(0);
    expect(state.references).toBe(0);
    expect(state.budget).toBe(0);
    expect(state.runs).toBe(0);
  });
  it('한쪽만 설정돼도 그쪽으로 열리고, 빈 비밀값은 자격이 아니다', async () => {
    state.cron = undefined;
    expect((await call('POST', `Bearer ${'w'.repeat(64)}`)).status).toBe(200);
    expect((await call('POST', 'Bearer ')).status).toBe(401);
    state.worker = undefined; state.cron = 'c'.repeat(40);
    expect((await call('GET', `Bearer ${'c'.repeat(40)}`)).status).toBe(200);
  });
  it('두 비밀값이 모두 없으면 503 — 실행하지 않는다', async () => {
    state.worker = undefined; state.cron = undefined;
    const res = await call('POST', 'Bearer anything');
    expect(res.status).toBe(503);
    expect(state.runs).toBe(0);
  });
});
