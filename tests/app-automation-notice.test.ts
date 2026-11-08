import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 관리자 조치 알림 메일(2026-11-08) — 주인 직원에게만, 사유·대상·할 일만(입력값·결과·관리자 이름 없음), 던지지 않음 */
type Result = { data?: unknown; error?: { message: string } | null };
const state = vi.hoisted(() => ({
  mail: true, sendFails: false, results: {} as Record<string, Result[]>, sent: [] as { to: string; subject: string; html: string }[], logs: [] as Record<string, unknown>[],
}));
vi.mock('@/lib/config', async (orig) => ({ ...(await orig<typeof import('@/lib/config')>()), APP_URL: 'https://w.example' }));
vi.mock('@/lib/logger', () => ({ logSystem: async (p: Record<string, unknown>) => { state.logs.push(p); } }));
vi.mock('@/lib/mailer', async (orig) => ({
  ...(await orig<typeof import('@/lib/mailer')>()),
  isMailConfigured: () => state.mail,
  sendAutomationAdminNoticeEmail: async (to: string, mail: { subject: string; html: string }) => {
    if (state.sendFails) return { sent: false, reason: 'error', error: 'resend 500' };
    state.sent.push({ to, ...mail }); return { sent: true };
  },
}));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) q[m] = () => q;
      q.maybeSingle = () => Promise.resolve({ data: null, error: null, ...(state.results[table]?.shift() ?? {}) });
      return q;
    },
  },
}));

import { notifyAutomationOwner, type AutomationNotice } from '@/lib/apps/automation-notice';

const base: AutomationNotice = { kind: 'webhook_revoked', organizationId: 'org', userId: 'u1', agentId: 'a1', targetId: 'w1', reason: '퇴사 예정자 <확인>', at: new Date('2026-11-08T01:00:00Z') };
beforeEach(() => { state.mail = true; state.sendFails = false; state.results = {}; state.sent = []; state.logs = []; });

describe('notifyAutomationOwner', () => {
  it('연동 회수 — 주인에게 앱·연동 이름·한국 시각·사유(이스케이프)·연동 화면 링크', async () => {
    state.results = { users: [{ data: { email: ' kim@example.go.kr ', is_active: true, deleted_at: null } }], agents: [{ data: { name: '민원 앱' } }], app_webhooks: [{ data: { name: '민원 시스템' } }] };
    await notifyAutomationOwner(base);
    expect(state.sent).toHaveLength(1);
    const [mail] = state.sent;
    expect(mail.to).toBe('kim@example.go.kr');
    expect(mail.subject).toContain('기관 관리자가 앱 연동을 회수했습니다 — 민원 앱');
    for (const kept of ["연동 '민원 시스템'", '2026-11-08 10:00', '퇴사 예정자 &lt;확인&gt;', 'https://w.example/apps/webhooks', '되돌릴 수 없음']) expect(mail.html).toContain(kept);
    expect(state.logs).toHaveLength(0);
  });
  it('예약 멈춤·잠금 풀기 — 예약 주기를 대상으로, 할 일 안내가 다르다', async () => {
    state.results = { users: [{ data: { email: 'lee@example.go.kr', is_active: true, deleted_at: null } }], agents: [{ data: { name: '주간 보고 앱' } }], app_schedules: [{ data: { frequency: 'weekly', weekday: 1, month_day: null, run_hour: 9, run_minute: 30 } }] };
    await notifyAutomationOwner({ ...base, kind: 'schedule_paused', targetId: 's1', reason: '비용 점검 중' });
    expect(state.sent[0].html).toContain('매주 월요일 09:30 예약');
    expect(state.sent[0].html).toContain('직원이 다시 켤 수 없습니다');
    expect(state.sent[0].html).toContain('https://w.example/apps/schedules');
    state.results = { users: [{ data: { email: 'lee@example.go.kr', is_active: true, deleted_at: null } }], agents: [{ data: { name: '주간 보고 앱' } }], app_schedules: [{ data: null }] };
    await notifyAutomationOwner({ ...base, kind: 'schedule_unlocked', targetId: 's1', reason: '점검 끝났습니다' });
    expect(state.sent[1].subject).toContain('잠금을 풀었습니다');
    expect(state.sent[1].html).toContain('앱 예약</td>');
    expect(state.sent[1].html).toContain('다시 켜거나 고칠 수 있습니다');
  });
  it('메일 설정이 없거나·탈퇴·비활성·주소 없음이면 보내지 않고 기록도 없다', async () => {
    state.mail = false; await notifyAutomationOwner(base);
    state.mail = true;
    for (const user of [{ email: 'a@x.kr', is_active: true, deleted_at: '2026-11-01T00:00:00Z' }, { email: 'a@x.kr', is_active: false, deleted_at: null }, { email: ' ', is_active: true, deleted_at: null }, null]) {
      state.results = { users: [{ data: user }] };
      await notifyAutomationOwner(base);
    }
    expect(state.sent).toHaveLength(0); expect(state.logs).toHaveLength(0);
  });
  it('보내기 실패·조회 실패는 던지지 않고 warning(사유 글 없이)만 남긴다', async () => {
    state.sendFails = true;
    state.results = { users: [{ data: { email: 'a@x.kr', is_active: true, deleted_at: null } }], agents: [{ data: { name: '앱' } }], app_webhooks: [{ data: { name: '연동' } }] };
    await expect(notifyAutomationOwner(base)).resolves.toBeUndefined();
    state.sendFails = false;
    state.results = { users: [{ error: { message: 'down' } }] };
    await notifyAutomationOwner(base);
    expect(state.logs).toHaveLength(2);
    expect(state.logs[0]).toMatchObject({ level: 'warning', message: '관리자 조치 알림 메일을 보내지 못함', orgId: 'org', details: { kind: 'webhook_revoked', target_id: 'w1' } });
    expect(JSON.stringify(state.logs)).not.toContain('퇴사 예정자');
  });
});
