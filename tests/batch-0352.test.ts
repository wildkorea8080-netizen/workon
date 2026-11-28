// tests/batch-0352.test.ts
// 확인할 일(2026-11-28) — 보내기 전 확인을 기다리는 결과·멈춘 앱 예약·공식 비서 등록 신청을 메일로만 알려,
// 운영 메일이 실패하는 동안 직원이 알 길이 없었다. 업무 틀 사이드바에 보인다
import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
import { loadMyAttention } from '@/lib/my-attention';
import { attentionItems } from '@/lib/my-attention-spec';
import { PAUSED_BY_USER } from '@/lib/apps/schedule-spec';
import { API_ROUTES } from '@/lib/api-route-ids';

const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const actor = (over: Record<string, unknown> = {}) => ({
  userId: 'u1', isAdmin: false, departmentId: 'd1', organizationId: 'o1', visibleDepartmentIds: ['d1'], managedDepartmentIds: [], managesWholeOrganization: false, ...over,
});

function fakeDb(results: Record<string, unknown>) {
  const calls: Record<string, unknown[][]> = {};
  const chain = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const n of ['select', 'eq', 'gte', 'limit', 'in', 'is']) q[n] = (...args: unknown[]) => { (calls[`${table}.${n}`] ??= []).push(args); return q; };
    q.then = (res: (v: unknown) => void) => res(results[table]);
    return q;
  };
  return { db: { from: (t: string) => chain(t) }, calls };
}

describe('줄 만들기', () => {
  it('0은 빼고, 보내기 전 확인은 가장 많이 기다리는 앱의 실행 화면으로', () => {
    expect(attentionItems({ approvalsByAgent: [], pausedSchedules: 0, officialRequests: 0 })).toEqual([]);
    const items = attentionItems({ approvalsByAgent: [{ agentId: A1, count: 1 }, { agentId: A2, count: 3 }], pausedSchedules: 2, officialRequests: 1 });
    expect(items).toEqual([
      { key: 'outbound_approvals', count: 4, label: '보내기 전 확인할 결과(앱 2개)', href: `/apps/run?agent=${A2}` },
      { key: 'paused_schedules', count: 2, label: '멈춘 앱 예약', href: '/apps/schedules' },
      { key: 'official_requests', count: 1, label: '공식 비서 등록 신청', href: '/admin/agents' },
    ]);
  });
});

describe('읽기', () => {
  it('내 것만 세고, 직원이 직접 멈춘 예약은 빼며, 일반 직원은 등록 신청을 세지 않는다', async () => {
    const { db, calls } = fakeDb({
      app_outbound_deliveries: { data: [{ agent_id: A1 }, { agent_id: A1 }], error: null },
      app_schedules: { data: [{ id: 's1', paused_reason: PAUSED_BY_USER }, { id: 's2', paused_reason: '연속 3번 실패해 멈췄습니다.' }, { id: 's3', paused_reason: null }], error: null },
    });
    const items = await loadMyAttention(actor() as never, Date.parse('2026-11-28T00:00:00Z'), db as never);
    expect(items.map((i) => [i.key, i.count])).toEqual([['outbound_approvals', 2], ['paused_schedules', 2]]);
    expect(calls['app_outbound_deliveries.eq']).toEqual(expect.arrayContaining([['user_id', 'u1'], ['organization_id', 'o1'], ['status', 'awaiting_approval']]));
    expect(calls['app_outbound_deliveries.gte'][0]).toEqual(['created_at', '2026-11-21T00:00:00.000Z']);
    expect(calls['app_schedules.eq']).toEqual(expect.arrayContaining([['user_id', 'u1'], ['status', 'paused']]));
    expect(calls['agents.select']).toBeUndefined();
  });
  it('관리자는 관리 범위의 지우지 않은 승인 대기 비서를 센다', async () => {
    const { db, calls } = fakeDb({
      app_outbound_deliveries: { data: [], error: null }, app_schedules: { data: [], error: null }, agents: { count: 3, error: null },
    });
    const items = await loadMyAttention(actor({ isAdmin: true, managedDepartmentIds: ['d1', 'd2'] }) as never, Date.now(), db as never);
    expect(items).toEqual([{ key: 'official_requests', count: 3, label: '공식 비서 등록 신청', href: '/admin/agents' }]);
    expect(calls['agents.in']).toEqual([['department_id', ['d1', 'd2']]]);
    expect(calls['agents.eq']).toEqual(expect.arrayContaining([['organization_id', 'o1'], ['approval_status', 'pending']]));
    expect(calls['agents.is']).toEqual([['deleted_at', null]]);
  });
  it('하나라도 못 읽으면 던진다', async () => {
    const { db } = fakeDb({ app_outbound_deliveries: { data: null, error: { code: '57014' } }, app_schedules: { data: [], error: null } });
    await expect(loadMyAttention(actor() as never, Date.now(), db as never)).rejects.toBeTruthy();
  });
  it('기관을 모르면 읽지 않는다', async () => {
    const { db, calls } = fakeDb({});
    expect(await loadMyAttention(actor({ organizationId: null }) as never, Date.now(), db as never)).toEqual([]);
    expect(Object.keys(calls)).toEqual([]);
  });
});

describe('라우트·화면', () => {
  it('세션 본인만·못 읽으면 503·라우트 목록에 있다', () => {
    const src = readFileSync('src/app/api/my/attention/route.ts', 'utf8');
    expect(src).toMatch(/actorScopeOr503\(session\)/);
    expect(src).toMatch(/status: 503/);
    expect(API_ROUTES).toContain('my/attention');
  });
  it('화면은 늦은 응답을 버리고, 못 읽으면 "없음"으로 숨기지 않는다', () => {
    const ui = readFileSync('src/components/work/AttentionList.tsx', 'utf8');
    expect(ui).toMatch(/if \(!gate\.current\.isLatest\(ticket\)\) return;/);
    expect(ui).toMatch(/if \(!total && !unread\) return null;/);
    expect(ui).toMatch(/ATTENTION_UNREAD/);
    expect(readFileSync('src/components/work/WorkShell.tsx', 'utf8')).toMatch(/<AttentionList collapsed=\{collapsed\} \/>/);
  });
});
