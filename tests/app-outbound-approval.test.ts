import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import {
  OUTBOUND_APPROVAL_ENDPOINT_GONE, OUTBOUND_APPROVAL_EXPIRED, OUTBOUND_APPROVAL_MS, OUTBOUND_STATUS_LABELS, approvalExpiresAt, parseCreateEndpoint, parseDecision,
} from '@/lib/apps/outbound/spec';
import { APPROVAL_CHANGED, APPROVAL_NOT_FOUND, decideApproval, type DecideDeps, type DeliveryRow } from '@/lib/apps/outbound/approval';
import { dispatchDueDeliveries, type OutboundDeps } from '@/lib/apps/outbound/deliver';

/** 앱 결과 보내기 전 사람 확인(0078) — 입력·정하기 규칙·기한·실행기·연결 */

const ID = '11111111-1111-4111-8111-111111111111';
const actor = { userId: 'u1', organizationId: 'o1', departmentId: 'd1' };
const NOW = Date.parse('2026-11-10T06:00:00Z');

function deps(row: Partial<DeliveryRow> | null, over: Partial<DecideDeps> = {}) {
  const updates: Array<{ patch: Record<string, unknown>; notBefore: string }> = [];
  const logs: unknown[] = [];
  const full: DeliveryRow | null = row === null ? null : {
    id: ID, organization_id: 'o1', user_id: 'u1', endpoint_id: 'e1', agent_id: 'a1', status: 'awaiting_approval', created_at: '2026-11-09T06:00:00Z', ...row,
  };
  const d: DecideDeps = {
    now: () => NOW,
    load: async () => full,
    activeEndpoint: async () => ({ name: '전자결재 연계' }),
    update: async (_row, patch, notBefore) => { updates.push({ patch, notBefore }); return true; },
    log: async (...args) => { logs.push(args); },
    ...over,
  };
  return { d, updates, logs };
}

describe('입력', () => {
  it("보낼 곳 만들기의 '보내기 전 확인'은 정확히 true일 때만 켜짐, 정하기는 approve·reject만", () => {
    expect(parseCreateEndpoint({ name: '연계', url: 'https://hook.example.com/a' })).toMatchObject({ ok: true, value: { requireApproval: false } });
    expect(parseCreateEndpoint({ name: '연계', url: 'https://hook.example.com/a', require_approval: true })).toMatchObject({ ok: true, value: { requireApproval: true } });
    expect(parseCreateEndpoint({ name: '연계', url: 'https://hook.example.com/a', require_approval: 'true' })).toMatchObject({ ok: true, value: { requireApproval: false } });
    expect(parseDecision({ decision: 'approve' })).toBe('approve');
    expect(parseDecision({ decision: 'reject' })).toBe('reject');
    for (const bad of [null, {}, { decision: 'yes' }, 'approve', []]) expect(parseDecision(bad)).toBeNull();
    expect(OUTBOUND_STATUS_LABELS.awaiting_approval).toBe('직원 확인 기다림');
    expect(approvalExpiresAt('2026-11-01T00:00:00Z') - Date.parse('2026-11-01T00:00:00Z')).toBe(7 * 86_400_000);
  });
});

describe('정하기', () => {
  it('보내기 — 다음 차례(pending)로, 정한 사람·때를 남기고 기한 조건으로 갱신, 보안 로그', async () => {
    const t = deps({});
    expect(await decideApproval(actor, ID, 'approve', t.d)).toEqual({ ok: true, status: 'pending' });
    expect(t.updates[0].patch).toEqual({ status: 'pending', next_attempt_at: new Date(NOW).toISOString(), decided_by: 'u1', decided_at: new Date(NOW).toISOString() });
    expect(t.updates[0].notBefore).toBe(new Date(NOW - OUTBOUND_APPROVAL_MS).toISOString());
    expect(t.logs).toHaveLength(1);
  });

  it('보내지 않기 — rejected, 보낼 곳은 보지 않는다', async () => {
    const activeEndpoint = vi.fn(async () => null);
    const t = deps({}, { activeEndpoint });
    expect(await decideApproval(actor, ID, 'reject', t.d)).toEqual({ ok: true, status: 'rejected' });
    expect(t.updates[0].patch).toMatchObject({ status: 'rejected', decided_by: 'u1' });
    expect(activeEndpoint).not.toHaveBeenCalled();
  });

  it('남의 결과·다른 기관·없는 기록·틀린 id는 404(있는지도 알리지 않음), 갱신하지 않는다', async () => {
    for (const row of [{ user_id: 'u2' }, { user_id: null }, { organization_id: 'o2' }, null] as Array<Partial<DeliveryRow> | null>) {
      const t = deps(row);
      expect(await decideApproval(actor, ID, 'approve', t.d)).toEqual({ ok: false, status: 404, message: APPROVAL_NOT_FOUND });
      expect(t.updates).toHaveLength(0);
    }
    expect(await decideApproval(actor, 'not-a-uuid', 'approve', deps({}).d)).toMatchObject({ status: 404 });
  });

  it('이미 정했거나 기한(7일)이 지났거나 보낼 곳이 회수됐으면 409', async () => {
    expect(await decideApproval(actor, ID, 'approve', deps({ status: 'pending' }).d)).toMatchObject({ ok: false, status: 409, message: expect.stringContaining('보낼 차례') });
    expect(await decideApproval(actor, ID, 'reject', deps({ status: 'sent' }).d)).toMatchObject({ status: 409 });
    const old = deps({ created_at: new Date(NOW - OUTBOUND_APPROVAL_MS - 1).toISOString() });
    expect(await decideApproval(actor, ID, 'approve', old.d)).toEqual({ ok: false, status: 409, message: OUTBOUND_APPROVAL_EXPIRED });
    expect(old.updates).toHaveLength(0);
    const gone = deps({}, { activeEndpoint: async () => null });
    expect(await decideApproval(actor, ID, 'approve', gone.d)).toEqual({ ok: false, status: 409, message: OUTBOUND_APPROVAL_ENDPOINT_GONE });
    expect(gone.updates).toHaveLength(0);
  });

  it('그 사이 바뀌었으면(조건부 갱신 실패) 409, 읽기·갱신 실패는 503, 로그 실패는 결과를 바꾸지 않는다', async () => {
    expect(await decideApproval(actor, ID, 'approve', deps({}, { update: async () => false }).d)).toEqual({ ok: false, status: 409, message: APPROVAL_CHANGED });
    expect(await decideApproval(actor, ID, 'approve', deps({}, { load: async () => { throw new Error('db'); } }).d)).toMatchObject({ status: 503 });
    expect(await decideApproval(actor, ID, 'approve', deps({}, { activeEndpoint: async () => { throw new Error('db'); } }).d)).toMatchObject({ status: 503 });
    expect(await decideApproval(actor, ID, 'reject', deps({}, { update: async () => { throw new Error('db'); } }).d)).toMatchObject({ status: 503 });
    expect(await decideApproval(actor, ID, 'reject', deps({}, { log: async () => { throw new Error('log'); } }).d)).toEqual({ ok: true, status: 'rejected' });
  });
});

describe('실행기·연결', () => {
  const base: OutboundDeps = {
    now: () => NOW, listDue: async () => [], claim: async () => false, load: async () => null, finish: async () => {},
    decrypt: () => '', checkHost: async () => ({ ok: true }), post: async () => ({ kind: 'sent', status: 200 }), log: async () => {},
  };

  it('차례마다 기한이 지난 확인 기다림을 그만둠으로(7일 전 기준), 실패해도 보내기는 이어 간다', async () => {
    const expire = vi.fn(async () => 2);
    expect(await dispatchDueDeliveries({ ...base, expireApprovals: expire })).toMatchObject({ expired: 2, claimed: 0 });
    expect(expire).toHaveBeenCalledWith(new Date(NOW - OUTBOUND_APPROVAL_MS).toISOString());
    const listDue = vi.fn(async () => []);
    expect(await dispatchDueDeliveries({ ...base, listDue, expireApprovals: async () => { throw new Error('db'); } })).toMatchObject({ expired: 0 });
    expect(listDue).toHaveBeenCalled();
  });

  it('확인 기다림은 보낼 차례 목록에 들지 않고(pending·sending만), 넣기·회수·목록·화면이 확인을 따른다', () => {
    const deliver = readFileSync('src/lib/apps/outbound/deliver.ts', 'utf8');
    expect(deliver).toContain(".or(`and(status.eq.pending,next_attempt_at.lte.${nowIso}),and(status.eq.sending,claimed_at.lt.${staleIso})`)");
    expect(deliver).toContain("status: awaiting ? 'awaiting_approval' : 'pending'");
    expect(deliver).toContain(".eq('status', 'awaiting_approval').lt('created_at', cutoffIso)");
    const admin = readFileSync('src/lib/apps/outbound/admin.ts', 'utf8');
    expect(admin).toContain(".in('status', ['pending', 'awaiting_approval'])");
    const approval = readFileSync('src/lib/apps/outbound/approval.ts', 'utf8');
    // 결과 글은 그 직원의 대화에서만, 갱신은 그 직원·확인 기다림·기한 조건으로
    expect(approval).toContain(".eq('conversation.user_id', actor.userId)");
    expect(approval).toContain(".eq('user_id', row.user_id!).eq('status', 'awaiting_approval').gte('created_at', notBeforeIso)");
    for (const route of ['src/app/api/apps/outbound-approvals/route.ts', 'src/app/api/apps/outbound-approvals/[id]/route.ts']) {
      expect(readFileSync(route, 'utf8')).toContain('userId: session.user.id');
    }
    expect(readFileSync('src/app/api/admin/outbound-endpoints/[id]/route.ts', 'utf8')).toMatch(/export async function PATCH[\s\S]*isAdminSession/);
    expect(readFileSync('src/app/apps/run/page.tsx', 'utf8')).toContain('{!draftSavedAt && <OutboundApprovalPanel agentId={agent.id}');
  });
});
