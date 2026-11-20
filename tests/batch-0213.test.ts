import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import { runOutboundNotices, type FailureEndpoint, type OutboundNoticeDeps, type WaitingDelivery } from '@/lib/apps/outbound/notices';

/**
 * 2026-11-20 — 앱 결과 보내기 알림이 받는 사람을 못 읽으면 차지를 되돌린다.
 * 알림은 먼저 '알린 때'를 조건부로 찍고(차지) 받는 사람을 읽는다. 예전엔
 * ① 기관 전체 관리자 주소를 못 읽으면 빈 목록으로 보아, 그 보낼 곳의 그만둠 알림이 6시간 동안 사라졌고
 * ② 직원 주소를 못 읽으면 '주소 없음'으로 보아, 보내기 전 확인 알림이 **기록 없이 영영** 사라졌다(다시 찍지 않음).
 * 이제 못 읽으면 차지를 되돌리고(다음 차례에 다시) 운영 기록에 남긴다. 정말 주소가 없는 직원(사용 중지 등)은 예전처럼 건너뛴다.
 */

const NOW = Date.parse('2026-11-20T03:00:00Z');
const ep: FailureEndpoint & { count: number; lastError: string | null; since: string } = {
  id: 'e1', organization_id: 'o1', name: '전자결재', failure_notified_at: null, count: 2, lastError: 'HTTP 500', since: new Date(NOW - 3_600_000).toISOString(),
};
const waiting: WaitingDelivery = { id: 'd1', user_id: 'u1', agent_id: 'a1', organization_id: 'o1', created_at: new Date(NOW - 30 * 60_000).toISOString() };

function deps(over: Partial<OutboundNoticeDeps>) {
  const sent: string[] = [];
  const logs: string[] = [];
  const d: OutboundNoticeDeps = {
    now: () => NOW, mailConfigured: () => true,
    failingEndpoints: async () => [], claimFailureNotice: async () => true, releaseFailureNotice: vi.fn(async () => {}), orgAdminEmails: async () => ['admin@org.go.kr'],
    waitingDeliveries: async () => [], claimApprovalNotices: async (ids) => ids, releaseApprovalNotices: vi.fn(async () => {}), userEmail: async (u) => `${u}@org.go.kr`,
    appNames: async () => new Map(), send: async (to) => { sent.push(to); return { sent: true }; },
    log: async (m) => { logs.push(m); }, ...over,
  };
  return { d, sent, logs };
}

describe('그만둠 알림 — 관리자 주소를 못 읽으면', () => {
  it('차지를 되돌리고 기록한다', async () => {
    const { d, sent, logs } = deps({ failingEndpoints: async () => [ep], orgAdminEmails: async () => { throw new Error('db'); } });
    const res = await runOutboundNotices(d);
    expect(res.failureMails).toBe(0);
    expect(sent).toEqual([]);
    expect(d.releaseFailureNotice).toHaveBeenCalledWith(ep, new Date(NOW).toISOString());
    expect(logs.some((m) => m.includes('다음 차례로 미뤘습니다'))).toBe(true);
  });
  it('관리자가 정말 없으면 되돌리지 않는다(예전과 같음)', async () => {
    const { d } = deps({ failingEndpoints: async () => [ep], orgAdminEmails: async () => [] });
    await runOutboundNotices(d);
    expect(d.releaseFailureNotice).not.toHaveBeenCalled();
  });
});

describe('보내기 전 확인 알림 — 직원 주소를 못 읽으면', () => {
  it('찍은 때를 되돌리고 기록한다', async () => {
    const { d, sent, logs } = deps({ waitingDeliveries: async () => [waiting], userEmail: async () => { throw new Error('db'); } });
    const res = await runOutboundNotices(d);
    expect(res.approvalMails).toBe(0);
    expect(sent).toEqual([]);
    expect(d.releaseApprovalNotices).toHaveBeenCalledWith(['d1'], new Date(NOW).toISOString());
    expect(logs.some((m) => m.includes('다음 차례로 미뤘습니다'))).toBe(true);
  });
  it('주소가 정말 없는 직원은 되돌리지 않고 건너뛴다', async () => {
    const { d, sent } = deps({ waitingDeliveries: async () => [waiting], userEmail: async () => null });
    await runOutboundNotices(d);
    expect(sent).toEqual([]);
    expect(d.releaseApprovalNotices).not.toHaveBeenCalled();
  });
});

describe('실제 의존', () => {
  const src = readFileSync('src/lib/apps/outbound/notices.ts', 'utf8');
  it('직원 주소 읽기 오류를 던진다', () => {
    const body = src.slice(src.indexOf('async userEmail('), src.indexOf('async appNames('));
    expect(body).toContain('const { data, error } = await supabaseAdmin');
    expect(body).toContain('if (error) throw new Error(error.message);');
  });
  it('되돌리기는 이번에 찍은 값일 때만(다른 차례가 찍은 것을 건드리지 않음)', () => {
    const f = src.slice(src.indexOf('async releaseFailureNotice('), src.indexOf('async orgAdminEmails('));
    expect(f).toContain(".eq('failure_notified_at', nowIso)");
    const a = src.slice(src.indexOf('async releaseApprovalNotices('), src.indexOf('async userEmail('));
    expect(a).toContain(".update({ approval_notified_at: null })");
    expect(a).toContain(".eq('approval_notified_at', nowIso)");
  });
});
