import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/logger', () => ({ logSystem: async () => {} }));

import { CRITICAL_ALERT_INTERVAL_MS, runCriticalAlert, type CriticalAlertDeps, type CriticalAlertState } from '@/lib/critical-alert';
import { criticalLogAlertMail } from '@/lib/mailer';

/**
 * 2026-11-17 — 심각한(critical) 운영 기록을 슈퍼관리자에게 메일로(한 시간에 한 번까지, 아직 알리지 않은 것만, 겹친 실행기는 한쪽만).
 */

const NOW = Date.parse('2026-11-17T03:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function deps(o: { state?: CriticalAlertState | null; count?: number; latestAt?: string | null; claim?: boolean; emails?: string[]; sendOk?: boolean; readThrows?: boolean } = {}) {
  const calls: string[] = [];
  const sent: Array<{ to: string; subject: string }> = [];
  const logs: string[] = [];
  const d: CriticalAlertDeps = {
    readState: vi.fn(async () => { if (o.readThrows) throw new Error('db'); return o.state === undefined ? null : o.state; }),
    criticalSince: vi.fn(async (since) => {
      calls.push(`since:${since}`);
      const count = o.count ?? 3;
      return { count, messages: Array(count).fill({ message: '사용 기록을 남기지 못했습니다(청구·한도에서 빠짐)' }), latestAt: o.latestAt === undefined ? ago(60_000) : o.latestAt };
    }),
    claim: vi.fn(async (prev, next) => { calls.push(`claim:${prev?.value ?? 'none'}->${next}`); return o.claim !== false; }),
    superAdminEmails: vi.fn(async () => o.emails ?? ['a@x.kr', 'b@x.kr']),
    send: vi.fn(async (to, mail) => { sent.push({ to, subject: mail.subject }); return { sent: o.sendOk !== false }; }),
    log: vi.fn(async (m) => { logs.push(m); }),
  };
  return { d, calls, sent, logs };
}

describe('runCriticalAlert', () => {
  it('처음(행 없음) — 최근 24시간 critical을 세어 차지하고 슈퍼관리자마다 메일', async () => {
    const { d, calls, sent } = deps();
    expect(await runCriticalAlert(d, NOW)).toEqual({ count: 3, notified: 2 });
    expect(calls[0]).toBe(`since:${ago(24 * 60 * 60_000)}`);
    expect(calls[1]).toBe(`claim:none->${ago(60_000)}`);
    expect(sent.map((s) => s.to)).toEqual(['a@x.kr', 'b@x.kr']);
    expect(sent[0].subject).toContain('심각한 운영 기록 3건');
  });
  it('한 시간 안에 알렸으면 쉰다(세지도 않음)', async () => {
    const { d, calls } = deps({ state: { value: ago(30 * 60_000), updatedAt: ago(CRITICAL_ALERT_INTERVAL_MS - 60_000) } });
    expect(await runCriticalAlert(d, NOW)).toEqual({ skipped: 'recent' });
    expect(calls).toEqual([]);
  });
  it('한 시간이 지났으면 알린 마지막 기록 뒤의 것만 센다', async () => {
    const lastCovered = ago(2 * 60 * 60_000);
    const { d, calls } = deps({ state: { value: lastCovered, updatedAt: ago(2 * 60 * 60_000) } });
    await runCriticalAlert(d, NOW);
    expect(calls[0]).toBe(`since:${lastCovered}`);
    expect(calls[1]).toBe(`claim:${lastCovered}->${ago(60_000)}`);
  });
  it('알린 지 하루가 넘었으면 최근 24시간까지만', async () => {
    const { d, calls } = deps({ state: { value: ago(3 * 24 * 60 * 60_000), updatedAt: ago(3 * 24 * 60 * 60_000) } });
    await runCriticalAlert(d, NOW);
    expect(calls[0]).toBe(`since:${ago(24 * 60 * 60_000)}`);
  });
  it('새 critical이 없으면 차지하지 않고 끝(다음 5분에 다시 봄)', async () => {
    const { d, calls, sent } = deps({ count: 0, latestAt: null });
    expect(await runCriticalAlert(d, NOW)).toEqual({ skipped: 'none' });
    expect(calls.some((c) => c.startsWith('claim'))).toBe(false);
    expect(sent).toEqual([]);
  });
  it('겹친 실행기가 먼저 차지했으면 보내지 않음', async () => {
    const { d, sent } = deps({ claim: false });
    expect(await runCriticalAlert(d, NOW)).toEqual({ skipped: 'raced' });
    expect(sent).toEqual([]);
  });
  it('하나도 못 보내면 warning 기록, 못 읽으면 error로 끝(던지지 않음)', async () => {
    const a = deps({ sendOk: false });
    expect(await runCriticalAlert(a.d, NOW)).toEqual({ count: 3, notified: 0 });
    expect(a.logs).toEqual(['심각한 운영 기록 알림 메일을 보내지 못함']);
    const b = deps({ readThrows: true });
    await expect(runCriticalAlert(b.d, NOW)).resolves.toEqual({ skipped: 'error' });
  });
});

describe('메일 글', () => {
  it('수·문구·시각만, 문구는 HTML로 이스케이프', () => {
    const mail = criticalLogAlertMail({ count: 2, top: [{ message: '<b>x</b>', count: 2 }], since: new Date(NOW - 3600_000), checkedAt: new Date(NOW), url: 'https://w/super/logs?tab=system&level=critical&period=week' });
    expect(mail.subject).toContain('심각한 운영 기록 2건');
    expect(mail.html).toContain('&lt;b&gt;x&lt;/b&gt; — 2건');
    expect(mail.html).toContain('11:00');
    expect(mail.html).not.toContain('<b>x</b>');
  });
});

describe('연결(원본)', () => {
  it('5분 실행기가 부르고 던져도 이어 간다, 실패 기록은 critical이 아님(알림이 알림을 부르지 않게)', () => {
    const route = readFileSync('src/app/api/cron/app-schedules/route.ts', 'utf8');
    expect(route).toContain('runCriticalAlert(criticalAlertDeps()).catch(() => null)');
    const lib = readFileSync('src/lib/critical-alert.ts', 'utf8');
    expect(lib).toContain("logSystem({ level: 'warning', category: 'admin', message, details })");
    expect(lib).not.toContain("level: 'critical'");
  });
});
