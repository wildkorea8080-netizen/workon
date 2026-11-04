import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import { RUNNER_STALE_MS, assessScheduleHealth, checkScheduleHealth, type HealthCheckDeps, type ScheduleHealth } from '@/lib/apps/schedule-health';
import { scheduleRunnerAlertMail } from '@/lib/mailer';

/** 앱 예약 실행기 상태 점검 — pg_cron이 조용히 멈추는 것을 다른 기반(Vercel 하루 한 번)이 잡는다 */
const now = Date.parse('2026-11-04T00:00:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();
const base = { heartbeatAt: ago(5 * 60_000), activeCount: 3, overdueCount: 0, stuckClaimCount: 0, nowMs: now };

describe('assessScheduleHealth(판정)', () => {
  it('30분 안에 불렸고 지연·멈춘 차지가 없으면 문제 없음', () => {
    expect(assessScheduleHealth(base)).toMatchObject({ runnerAlive: true, problems: [] });
    expect(assessScheduleHealth({ ...base, heartbeatAt: ago(RUNNER_STALE_MS) }).runnerAlive).toBe(true);
  });
  it('켜진 예약이 있는데 30분 넘게 소식이 없거나 기록이 없으면 문제 — 켜진 예약이 없으면 상태만 남기고 문제로 치지 않는다', () => {
    expect(assessScheduleHealth({ ...base, heartbeatAt: ago(RUNNER_STALE_MS + 1) })).toMatchObject({ runnerAlive: false, problems: ['예약 실행기가 30분 넘게 불리지 않았습니다.'] });
    expect(assessScheduleHealth({ ...base, heartbeatAt: null }).problems).toEqual(['예약 실행기가 한 번도 불린 기록이 없습니다.']);
    expect(assessScheduleHealth({ ...base, heartbeatAt: 'garbage' }).runnerLastRunAt).toBeNull();
    expect(assessScheduleHealth({ ...base, heartbeatAt: null, activeCount: 0 })).toMatchObject({ runnerAlive: false, problems: [] });
  });
  it('1시간 넘게 지난 예약·30분 넘게 남은 차지는 실행기가 불려도 문제', () => {
    const h = assessScheduleHealth({ ...base, overdueCount: 2, stuckClaimCount: 1 });
    expect(h.runnerAlive).toBe(true);
    expect(h.problems).toEqual(['예정 시각이 1시간 넘게 지났는데 실행되지 않은 예약이 2개 있습니다.', '30분 넘게 실행 중으로 남은 예약이 1개 있습니다.']);
  });
});

function deps(health: ScheduleHealth | Error, emails = ['ops@workon.test', 'ops2@workon.test']) {
  return {
    read: vi.fn<HealthCheckDeps['read']>(async () => { if (health instanceof Error) throw health; return health; }),
    superAdminEmails: vi.fn<HealthCheckDeps['superAdminEmails']>(async () => emails),
    send: vi.fn<HealthCheckDeps['send']>(async () => ({ sent: true })),
    log: vi.fn<HealthCheckDeps['log']>(async () => {}),
    now: () => now,
  } satisfies HealthCheckDeps;
}

describe('checkScheduleHealth(하루 한 번 점검)', () => {
  it('문제가 없으면 메일·critical 없음', async () => {
    const d = deps(assessScheduleHealth(base));
    expect(await checkScheduleHealth(d)).toEqual({ ok: true, problems: [], notified: 0 });
    expect(d.send).not.toHaveBeenCalled(); expect(d.log).not.toHaveBeenCalled();
  });
  it('켜진 예약 없이 실행기만 멈췄으면 warning만 남긴다(메일 없음)', async () => {
    const d = deps(assessScheduleHealth({ ...base, heartbeatAt: null, activeCount: 0 }));
    expect((await checkScheduleHealth(d)).ok).toBe(true);
    expect(d.log).toHaveBeenCalledWith('warning', expect.stringContaining('소식 없음'), expect.objectContaining({ active: 0 }));
    expect(d.send).not.toHaveBeenCalled();
  });
  it('문제가 있으면 critical 기록(숫자·시각만)과 슈퍼관리자마다 메일 한 통', async () => {
    const d = deps(assessScheduleHealth({ ...base, heartbeatAt: ago(2 * 60 * 60_000), overdueCount: 4 }));
    const r = await checkScheduleHealth(d);
    expect(r).toMatchObject({ ok: false, notified: 2 });
    expect(r.problems).toHaveLength(2);
    expect(d.log).toHaveBeenCalledWith('critical', '앱 예약 실행기 점검 — 확인 필요', expect.objectContaining({ active: 3, overdue: 4, stuck_claims: 0, runner_last_run_at: ago(2 * 60 * 60_000) }));
    expect(d.send.mock.calls.map((c) => c[0])).toEqual(['ops@workon.test', 'ops2@workon.test']);
    expect(d.send.mock.calls[0][1].subject).toContain('앱 예약 실행기 확인 필요');
  });
  it('읽기 실패·메일 실패에도 던지지 않는다', async () => {
    const broken = deps(new Error('db down'));
    expect(await checkScheduleHealth(broken)).toMatchObject({ ok: false, error: 'db down', notified: 0 });
    expect(broken.log).toHaveBeenCalledWith('warning', '앱 예약 실행기 상태를 점검하지 못함', { error: 'db down' });
    const noMail = deps(assessScheduleHealth({ ...base, overdueCount: 1 }));
    noMail.superAdminEmails.mockRejectedValueOnce(new Error('users down'));
    expect(await checkScheduleHealth(noMail)).toMatchObject({ ok: false, notified: 0 });
    expect(noMail.log.mock.calls.map((c) => c[1])).toContain('앱 예약 실행기 점검 메일을 보내지 못함');
  });
});

describe('메일·연결(원본 확인)', () => {
  it('메일에 문제·마지막 호출(한국 시간)·조치가 있고 글자는 이스케이프한다', () => {
    const mail = scheduleRunnerAlertMail({ problems: ['<b>문제</b>'], runnerLastRunAt: '2026-11-03T15:00:00Z', activeCount: 2, checkedAt: new Date(now), superUrl: 'https://x.kr/super/logs' });
    expect(mail.html).toContain('&lt;b&gt;문제&lt;/b&gt;');
    expect(mail.html).toContain('2026-11-04 00:00 (한국 시간)');
    expect(mail.html).toContain('workon-app-schedules');
    expect(mail.html).toContain('https://x.kr/super/logs');
    expect(scheduleRunnerAlertMail({ problems: [], runnerLastRunAt: null, activeCount: 0, checkedAt: new Date(now), superUrl: 'u' }).html).toContain('기록 없음');
  });
  it('하루 한 번 Vercel 예약 작업이 예산 알림보다 먼저 점검하고, 실행기는 인증 뒤에 도장을 찍는다', () => {
    const budget = readFileSync('src/app/api/cron/budget-alerts/route.ts', 'utf8');
    expect(budget.indexOf('checkScheduleHealth(scheduleHealthDeps())')).toBeGreaterThan(-1);
    expect(budget.indexOf('checkScheduleHealth(scheduleHealthDeps())')).toBeLessThan(budget.indexOf('runBudgetAlerts(budgetAlertDeps())'));
    const runner = readFileSync('src/app/api/cron/app-schedules/route.ts', 'utf8');
    expect(runner.indexOf('recordRunnerHeartbeat(')).toBeGreaterThan(runner.indexOf("status: 401"));
    expect(runner.indexOf('recordRunnerHeartbeat(')).toBeLessThan(runner.indexOf('runDueSchedules(scheduleDeps())'));
  });
});
