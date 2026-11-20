import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-19 — 직원의 앱 예약·연동 목록이 '기관이 멈춤'의 까닭을 가른다.
 * 0201·0202부터 정지·종료한 기관의 예약은 넘기고 연동 호출은 403인데, 목록 안내는 스위치만 보아(연동) 아무 말이 없거나
 * (예약) '기관 관리자가 앱 예약 실행을 꺼 두었습니다'로 잘못 말했다.
 */

const state = { row: null as Record<string, unknown> | null, selected: '' };
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = (cols: string) => { state.selected = cols; return b; };
      b.eq = () => b;
      b.maybeSingle = async () => ({ data: state.row, error: null });
      return b;
    },
  },
}));
vi.mock('@/lib/filter', () => ({ logSecurityEvent: vi.fn() }));

import { orgAutomationBlock } from '@/lib/apps/webhook-switch';
import { scheduleView } from '@/lib/apps/schedule-spec';
import { webhookView } from '@/lib/apps/webhook-spec';

beforeEach(() => { state.row = { app_webhooks_disabled_at: null, app_schedules_disabled_at: null, status: 'active' }; });

describe('orgAutomationBlock', () => {
  it('정지·종료가 스위치보다 먼저', async () => {
    state.row = { app_webhooks_disabled_at: 'x', status: 'terminated' };
    expect(await orgAutomationBlock('webhooks', 'o1')).toBe('stopped');
    expect(state.selected).toBe('app_webhooks_disabled_at, status');
  });
  it('스위치만 꺼짐 → true, 둘 다 아님 → false', async () => {
    state.row = { app_schedules_disabled_at: 'x', status: 'active' };
    expect(await orgAutomationBlock('schedules', 'o1')).toBe(true);
    state.row = { app_schedules_disabled_at: null, status: 'trial' };
    expect(await orgAutomationBlock('schedules', 'o1')).toBe(false);
  });
});

describe('목록 보기', () => {
  const sched = {
    id: 's1', agent_id: 'a1', app_version: 1, inputs: {}, document_ids: [], status: 'active', paused_reason: null, admin_paused_at: null,
    next_run_at: '2026-11-19T00:00:00Z', last_run_at: null, last_status: null, last_error: null, last_conversation_id: null,
    consecutive_failures: 0, run_count: 0, created_at: '2026-11-01T00:00:00Z', notify_on_success: false, export_hwpx: false, files: [],
    frequency: 'daily', run_hour: 9, run_minute: 0, weekday: null, month_day: null,
  };
  it('예약: 기관 정지·종료면 넘김 + 까닭', () => {
    const v = scheduleView(sched as never, '앱', Date.parse('2026-11-19T00:00:00Z'), 'stopped');
    expect(v.heldByOrg).toBe(true);
    expect(v.orgStopped).toBe(true);
    const sw = scheduleView(sched as never, '앱', Date.parse('2026-11-19T00:00:00Z'), true);
    expect(sw.heldByOrg).toBe(true);
    expect(sw.orgStopped).toBe(false);
  });
  it('연동: 기관 정지·종료면 막힘 + 까닭', () => {
    const hook = {
      id: 'w1', agent_id: 'a1', app_version: 1, name: '연동', token_prefix: 'wo_wh_x', document_ids: [], status: 'active',
      expires_at: '2027-01-01T00:00:00Z', revoked_at: null, revoked_reason: null, last_used_at: null, use_count: 0,
      last_status: null, last_error: null, last_conversation_id: null, created_at: '2026-11-01T00:00:00Z',
    };
    const v = webhookView(hook as never, '앱', Date.parse('2026-11-19T00:00:00Z'), 'stopped');
    expect(v).toMatchObject({ blockedByOrg: true, orgStopped: true });
    expect(webhookView(hook as never, '앱', Date.parse('2026-11-19T00:00:00Z'), false)).toMatchObject({ blockedByOrg: false, orgStopped: false });
  });
  it('화면이 까닭에 맞는 안내를 고른다', () => {
    expect(readFileSync('src/app/apps/schedules/page.tsx', 'utf8')).toContain('{s.orgStopped ? SCHEDULE_ORG_STOPPED : SCHEDULE_ORG_DISABLED}');
    expect(readFileSync('src/app/apps/webhooks/page.tsx', 'utf8')).toContain('{w.orgStopped ? WEBHOOK_ORG_STOPPED : WEBHOOK_ORG_DISABLED}');
  });
});
