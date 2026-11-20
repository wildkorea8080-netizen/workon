import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-19 — 정지·종료한 기관의 앱 예약은 실행하지 않고 다음 차례로 넘긴다(기관 예약 스위치를 끈 것과 같게).
 * 예전 실행기는 스위치(0070)만 보아 정지한 기관의 예약도 돌렸고, 대화 준비가 429(기관 정지)로 거절한 것을 실패로 세었다 —
 * 세 번이면 예약이 멈추고 직원마다 실패 메일이 갔으며, 기관을 다시 켜도 예약은 멈춘 채였다.
 */

const state = { row: null as Record<string, unknown> | null, error: null as unknown, selected: '' };

vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = (cols: string) => { state.selected = cols; return b; };
      b.eq = () => b;
      b.maybeSingle = async () => ({ data: state.error ? null : state.row, error: state.error });
      return b;
    },
  },
}));
vi.mock('@/lib/filter', () => ({ logSecurityEvent: vi.fn() }));

import { scheduleRunHeld } from '@/lib/apps/webhook-switch';

beforeEach(() => { state.row = { app_schedules_disabled_at: null, status: 'active' }; state.error = null; });

describe('scheduleRunHeld', () => {
  it('활성 기관·스위치 켜짐이면 실행', async () => {
    expect(await scheduleRunHeld('o1')).toBe(false);
    expect(state.selected).toBe('app_schedules_disabled_at, status');
  });
  it('스위치를 끈 기관은 넘김', async () => {
    state.row = { app_schedules_disabled_at: '2026-11-19T00:00:00Z', status: 'active' };
    expect(await scheduleRunHeld('o1')).toBe(true);
  });
  it.each(['suspended', 'terminated'])('%s 기관은 넘김', async (status) => {
    state.row = { app_schedules_disabled_at: null, status };
    expect(await scheduleRunHeld('o1')).toBe(true);
  });
  it('체험 기관은 실행', async () => {
    state.row = { app_schedules_disabled_at: null, status: 'trial' };
    expect(await scheduleRunHeld('o1')).toBe(false);
  });
  it('못 읽으면 던진다(실행기는 차지하지 않고 다음 호출에 다시 봄)', async () => {
    state.error = { message: 'down' };
    await expect(scheduleRunHeld('o1')).rejects.toThrow();
  });
});

describe('원본 확인', () => {
  it('실행기와 직원 목록이 같은 판정을 쓴다', () => {
    expect(readFileSync('src/lib/apps/schedules.ts', 'utf8')).toContain('orgDisabled: (organizationId) => scheduleRunHeld(organizationId),');
    expect(readFileSync('src/app/api/apps/schedules/route.ts', 'utf8')).toContain("await orgAutomationBlock('schedules', actor.organizationId).catch(() => false as const)");
  });
});
