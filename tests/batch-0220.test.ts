import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-20 — 앱의 문서 찾기 단계가 찾을 **다른 비서**를 못 읽은 것을 '쓸 수 없음'(403)으로 거절하지 않는다.
 * 대화 준비는 실행 전에 그 비서를 실행하는 사람이 쓸 수 있는지 본다(`checkLookupAgents`). 예전엔 비서 읽기 실패도
 * '쓸 수 없습니다'(403)였고, 예약 실행기·일괄 실행은 거절 403을 **'앱을 쓸 수 없음'**으로 읽는다 —
 * 잠깐의 DB 오류에 예약이 바로 멈추고 직원에게 메일이 갔다(일괄 실행은 묶음 전체가 멈춤).
 * 이제 못 읽으면 `unread` → 503(그 차례 실패 — 다음 차례에 다시). 정말 쓸 수 없으면 예전처럼 403.
 */

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: { from: () => ({}) } }));

import { checkLookupAgents, lookupAgentDenied, LOOKUP_AGENT_UNREAD, type LookupAgentRow } from '@/lib/apps/app-doc-lookup';
import { executeSchedule, PAUSED_APP_UNAVAILABLE, type AppScheduleRow, type ExecuteIo } from '@/lib/apps/schedules';
import type { PreparedTurn } from '@/lib/assistant/types';

const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const actor = { userId: 'me', isAdmin: false, organizationId: 'org', departmentId: 'dept', visibleDepartmentIds: ['dept'], managedDepartmentIds: [], managesWholeOrganization: false } as never;
const load = (rows: LookupAgentRow[] | null) => async () => rows;

describe('checkLookupAgents', () => {
  it('비서를 못 읽으면 unread(쓸 수 없음이 아님)', async () => {
    expect(await checkLookupAgents([OTHER], actor, load(null))).toEqual({ ok: false, unread: true, message: LOOKUP_AGENT_UNREAD });
  });
  it('정말 없으면 쓸 수 없음(unread 아님)', async () => {
    expect(await checkLookupAgents([OTHER], actor, load([]))).toEqual({ ok: false, message: lookupAgentDenied(null) });
  });
});

describe('대화 준비', () => {
  it('unread는 503, 그 밖은 403', () => {
    const src = readFileSync('src/lib/assistant/prepare.ts', 'utf8');
    expect(src).toContain('if (!checked.ok) return reject(checked.message, checked.unread ? 503 : 403);');
  });
});

describe('예약 실행기', () => {
  const row = { id: 's1', agent_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', user_id: 'u1', department_id: 'd1', organization_id: 'o1', app_version: 3, inputs: { title: '점검' }, document_ids: [],
    frequency: 'daily', weekday: null, month_day: null, run_hour: 9, run_minute: 0, status: 'active', paused_reason: null,
    next_run_at: '2026-11-03T00:00:00.000Z', claimed_at: null, last_run_at: null, last_status: null, last_error: null, last_conversation_id: null,
    consecutive_failures: 0, run_count: 0, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z' } as unknown as AppScheduleRow;
  const io = (status: number, message: string) => ({
    loadUser: vi.fn(async () => ({ id: 'u1', email: null, role: 'USER', department_id: 'd1', is_active: true, deleted_at: null })),
    prepare: vi.fn(async () => ({ ok: false as const, status, message })),
    stream: vi.fn(async (_t: PreparedTurn) => {}),
    retitle: vi.fn(async () => {}),
  }) as unknown as ExecuteIo;

  it('못 읽음(503)은 그 차례 실패 — 예약을 멈추지 않는다', async () => {
    expect(await executeSchedule(row, io(503, LOOKUP_AGENT_UNREAD))).toMatchObject({ kind: 'failed' });
  });
  it('쓸 수 없음(403)은 예전처럼 멈춤', async () => {
    expect(await executeSchedule(row, io(403, lookupAgentDenied('감사 비서')))).toEqual({ kind: 'pause', reason: PAUSED_APP_UNAVAILABLE });
  });
});
