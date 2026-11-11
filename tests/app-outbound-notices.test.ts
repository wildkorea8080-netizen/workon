import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import {
  APPROVAL_NOTICE_DELAY_MS, FAILURE_NOTICE_INTERVAL_MS, runOutboundNotices, type FailureEndpoint, type OutboundNoticeDeps, type WaitingDelivery,
} from '@/lib/apps/outbound/notices';
import { approvalWaitingMail, outboundFailureMail } from '@/lib/mailer';

/** 앱 결과 보내기 알림(2026-11-10, 0081) — 그만둔 보내기는 기관 전체 관리자에게(보낼 곳마다 6시간에 한 번), 확인 기다림은 실행한 직원에게(결과마다 한 번) */

const NOW = Date.parse('2026-11-10T06:00:00Z');
const ep = (over: Partial<FailureEndpoint & { count: number; lastError: string | null; since: string }> = {}) => ({
  id: 'e1', organization_id: 'o1', name: '전자결재 연계', failure_notified_at: null, count: 3, lastError: '받는 쪽이 400으로 거절했습니다(서명·주소를 확인해 주세요).', since: '2026-11-09T06:00:00Z', ...over,
});
const waiting = (id: string, user: string, agent: string, minutesAgo = 30): WaitingDelivery => ({ id, user_id: user, agent_id: agent, organization_id: 'o1', created_at: new Date(NOW - minutesAgo * 60_000).toISOString() });

function deps(over: Partial<OutboundNoticeDeps> = {}) {
  const sent: Array<{ to: string; subject: string; html: string }> = [];
  const logs: string[] = [];
  const d: OutboundNoticeDeps = {
    now: () => NOW, mailConfigured: () => true,
    failingEndpoints: async () => [], claimFailureNotice: async () => true, orgAdminEmails: async () => ['admin@org.go.kr'],
    waitingDeliveries: async () => [], claimApprovalNotices: async (ids) => ids, userEmail: async (u) => `${u}@org.go.kr`,
    appNames: async () => new Map([['a1', '민원 답변 앱'], ['a2', '주간 보고 앱']]),
    send: async (to, mail) => { sent.push({ to, ...mail }); return { sent: true }; },
    log: async (m) => { logs.push(m); }, ...over,
  };
  return { d, sent, logs };
}

describe('그만둔 보내기 알림', () => {
  it('기관 전체 관리자에게 보낼 곳·수·마지막 이유·관리 화면 링크 — 결과 글은 없음', async () => {
    const claim = vi.fn(async () => true);
    const t = deps({ failingEndpoints: async () => [ep()], claimFailureNotice: claim, orgAdminEmails: async () => ['a@org.go.kr', 'b@org.go.kr'] });
    expect(await runOutboundNotices(t.d)).toEqual({ failureMails: 2, approvalMails: 0 });
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }), new Date(NOW).toISOString());
    expect(t.sent.map((s) => s.to)).toEqual(['a@org.go.kr', 'b@org.go.kr']);
    expect(t.sent[0].subject).toContain('전자결재 연계');
    expect(t.sent[0].html).toContain('3건');
    expect(t.sent[0].html).toContain('400으로 거절');
    expect(t.sent[0].html).toContain('/admin/app-automations');
  });
  it('6시간 안에 알렸으면 건너뛰고, 차지를 놓치면(다른 호출이 알림) 보내지 않는다', async () => {
    const recent = deps({ failingEndpoints: async () => [ep({ failure_notified_at: new Date(NOW - FAILURE_NOTICE_INTERVAL_MS + 60_000).toISOString() })] });
    expect((await runOutboundNotices(recent.d)).failureMails).toBe(0);
    const old = deps({ failingEndpoints: async () => [ep({ failure_notified_at: new Date(NOW - FAILURE_NOTICE_INTERVAL_MS - 60_000).toISOString() })] });
    expect((await runOutboundNotices(old.d)).failureMails).toBe(1);
    const lost = deps({ failingEndpoints: async () => [ep()], claimFailureNotice: async () => false });
    expect((await runOutboundNotices(lost.d)).failureMails).toBe(0);
    expect(lost.sent).toHaveLength(0);
  });
  it('받을 관리자가 없거나 보내지 못하면 기록만, 목록을 못 읽어도 던지지 않는다', async () => {
    const none = deps({ failingEndpoints: async () => [ep()], orgAdminEmails: async () => [] });
    await runOutboundNotices(none.d);
    expect(none.logs.some((l) => l.includes('그만둠 알림을 보내지 못했습니다'))).toBe(true);
    const broken = deps({ failingEndpoints: async () => { throw new Error('db'); } });
    await expect(runOutboundNotices(broken.d)).resolves.toEqual({ failureMails: 0, approvalMails: 0 });
    expect(broken.logs.some((l) => l.includes('확인하지 못했습니다'))).toBe(true);
  });
  it('메일이 설정되지 않았으면 아무것도 읽지도 차지하지도 않는다', async () => {
    const failing = vi.fn(async () => [ep()]);
    const waitingFn = vi.fn(async () => [waiting('d1', 'u1', 'a1')]);
    const t = deps({ mailConfigured: () => false, failingEndpoints: failing, waitingDeliveries: waitingFn });
    await runOutboundNotices(t.d);
    expect(failing).not.toHaveBeenCalled();
    expect(waitingFn).not.toHaveBeenCalled();
  });
});

describe('확인 기다림 알림', () => {
  it('10분 지난 것만 묻고, 직원 한 명에 한 통 — 앱마다 수·실행 화면 링크·가장 빠른 마감', async () => {
    const waitingFn = vi.fn(async () => [waiting('d1', 'u1', 'a1'), waiting('d2', 'u1', 'a2', 60), waiting('d3', 'u1', 'a1'), waiting('d4', 'u2', 'a1')]);
    const t = deps({ waitingDeliveries: waitingFn });
    expect((await runOutboundNotices(t.d)).approvalMails).toBe(2);
    expect(waitingFn).toHaveBeenCalledWith(new Date(NOW - APPROVAL_NOTICE_DELAY_MS).toISOString(), expect.any(String), 200);
    const u1 = t.sent.find((s) => s.to === 'u1@org.go.kr')!;
    expect(u1.subject).toContain('3건');
    expect(u1.html).toContain('민원 답변 앱</a> — 2건');
    expect(u1.html).toContain('주간 보고 앱</a> — 1건');
    expect(u1.html).toContain('/apps/run?agent=a1');
  });
  it('차지한 결과만 알린다(다른 호출이 먼저 찍은 것은 빼고), 주소를 못 찾은 직원은 건너뛴다', async () => {
    const t = deps({
      waitingDeliveries: async () => [waiting('d1', 'u1', 'a1'), waiting('d2', 'u2', 'a1')],
      claimApprovalNotices: async () => ['d2'], userEmail: async (u) => (u === 'u2' ? null : `${u}@x`),
    });
    expect((await runOutboundNotices(t.d)).approvalMails).toBe(0);
    expect(t.sent).toHaveLength(0);
  });
});

describe('메일 글', () => {
  it('이름은 HTML로 해석되지 않는다', () => {
    const f = outboundFailureMail({ endpointName: '<b>x</b>', count: 1, lastError: null, since: new Date(NOW), url: 'https://x' });
    expect(f.html).not.toContain('<b>x</b>');
    const a = approvalWaitingMail({ apps: [{ name: '<script>', count: 1, url: 'https://x/a"b' }], total: 1, earliestDeadline: new Date(NOW) });
    expect(a.html).not.toContain('<script>');
    expect(a.html).not.toContain('a"b');
    expect(a.html).toContain('결과 글은 메일에 싣지 않습니다');
  });
});

describe('연결', () => {
  it('실행기와 나란히, 그만둠은 실제로 보내 본 것만·회수되지 않은 곳만, 확인 기다림은 아직 알리지 않은 것만 조건부로', () => {
    expect(readFileSync('src/app/api/cron/app-schedules/route.ts', 'utf8')).toContain('runOutboundNotices().catch(() => null)');
    const lib = readFileSync('src/lib/apps/outbound/notices.ts', 'utf8');
    expect(lib).toContain(".eq('status', 'gave_up').gte('attempts', 1)");
    expect(lib).toContain(".is('revoked_at', null)");
    expect(lib).toContain(".in('id', ids).eq('status', 'awaiting_approval').is('approval_notified_at', null)");
    expect(lib).toContain(".is('parent_id', null)");
  });
});
