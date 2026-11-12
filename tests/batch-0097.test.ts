import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/config', () => ({ APP_URL: 'https://workon.example', APP_NAME: 'WORKON' }));
vi.mock('@/lib/logger', () => ({ logSystem: vi.fn() }));

import { quickBudgetAlertDue, runBudgetAlerts, type BudgetAlertDeps } from '@/lib/budget-alerts';
import type { OrganizationBudgetStatus } from '@/lib/usage-limit';

/** 2026-11-12 — 예산 알림 빠른 확인(앱 예약 실행기가 15분마다, 새 알림만·조용히) */

const kst = (hhmm: string) => Date.parse(`2026-11-12T${hhmm}:30+09:00`);

describe('빠른 확인 차례', () => {
  it('KST 15분 단위의 첫 5분(:00·:15·:30·:45 호출)에만', () => {
    expect(quickBudgetAlertDue(kst('14:00'))).toBe(true);
    expect(quickBudgetAlertDue(kst('14:04'))).toBe(true);
    expect(quickBudgetAlertDue(kst('14:05'))).toBe(false);
    expect(quickBudgetAlertDue(kst('14:10'))).toBe(false);
    expect(quickBudgetAlertDue(kst('14:15'))).toBe(true);
    expect(quickBudgetAlertDue(kst('14:45'))).toBe(true);
    expect(quickBudgetAlertDue(kst('14:59'))).toBe(false);
  });
});

function deps(over: Partial<BudgetAlertDeps> = {}) {
  const status = { kind: 'annual_budget', used: 85_000, limit: 100_000, percent: 85, alertPercent: 80, periodKey: 'contract:c1', periodEndsAt: null } as unknown as OrganizationBudgetStatus;
  const d: BudgetAlertDeps = {
    mailConfigured: () => true,
    organizations: async () => [{ id: 'o1', name: '가 공사' }],
    status: vi.fn(async () => status),
    departmentStatuses: vi.fn(async () => ({ statuses: [], failed: 0 })),
    userStatuses: vi.fn(async () => { throw new Error('db'); }),
    recipients: vi.fn(async () => ['admin@example.go.kr']),
    person: vi.fn(async () => null),
    claim: vi.fn(async () => true),
    finish: vi.fn(async () => {}),
    send: vi.fn(async () => ({ sent: true })) as unknown as BudgetAlertDeps['send'],
    log: vi.fn(async () => {}),
    now: () => Date.parse('2026-11-12T05:00:00Z'),
    ...over,
  };
  return d;
}

describe('runBudgetAlerts — 빠른 확인', () => {
  it('새 알림만 차지하고(retake: false) 보낸다', async () => {
    const d = deps();
    const run = await runBudgetAlerts(d, 20_000, { quick: true });
    expect(run).toMatchObject({ checked: 1, sent: 1 });
    expect(d.claim).toHaveBeenCalledWith(expect.objectContaining({ subject: 'org', threshold: 80 }), { retake: false });
    expect(d.send).toHaveBeenCalledTimes(1);
  });
  it('사용률을 못 읽은 경고는 남기지 않는다(하루 한 번 실행은 남김)', async () => {
    const quick = deps();
    await runBudgetAlerts(quick, 20_000, { quick: true });
    expect(quick.log).not.toHaveBeenCalledWith('warning', '개인 한도 사용률을 확인하지 못했습니다', expect.anything(), 'o1');
    const daily = deps();
    await runBudgetAlerts(daily);
    expect(daily.log).toHaveBeenCalledWith('warning', '개인 한도 사용률을 확인하지 못했습니다', expect.anything(), 'o1');
    // 하루 한 번 실행은 예전처럼(다시 잡기 허용) 차지한다
    expect((daily.claim as ReturnType<typeof vi.fn>).mock.calls[0]).toHaveLength(1);
  });
  it('이미 보냈거나 실패한 기록이면(차지 못 함) 보내지 않는다', async () => {
    const d = deps({ claim: vi.fn(async () => false) });
    expect(await runBudgetAlerts(d, 20_000, { quick: true })).toMatchObject({ sent: 0 });
    expect(d.send).not.toHaveBeenCalled();
  });
  it('메일이 설정되지 않았으면 아무것도 하지 않는다', async () => {
    const d = deps({ mailConfigured: () => false });
    expect(await runBudgetAlerts(d, 20_000, { quick: true })).toMatchObject({ skipped: 'not_configured' });
    expect(d.status).not.toHaveBeenCalled();
  });
  it('연결(원본) — 실행기가 15분 차례에만 나란히 부르고, 차지는 retake: false면 겹친 기록을 다시 잡지 않는다', () => {
    const route = readFileSync('src/app/api/cron/app-schedules/route.ts', 'utf8');
    expect(route).toContain('quickBudgetAlertDue(now) ? runBudgetAlerts(budgetAlertDeps(), 20_000, { quick: true }).catch(() => null) : Promise.resolve(null)');
    const lib = readFileSync('src/lib/budget-alerts.ts', 'utf8');
    expect(lib).toMatch(/if \(inserted\.error\.code !== '23505'\)[^\n]*\n\s*if \(options\?\.retake === false\) return false;/);
  });
});
