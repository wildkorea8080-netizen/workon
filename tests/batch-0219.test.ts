import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-20 — 문서함에서 고른 문서(입력형 앱·예약·연동)의 원본을 '지금 못 받은 것'과 '없는 것'으로 가르고, 둘 다 404로 답하지 않는다.
 * 예전엔 둘 다 404 '원본 파일을 찾을 수 없습니다'였다. 예약 실행기·일괄 실행은 거절 404를 **'앱을 쓸 수 없음'**으로 읽는다 —
 * 잠깐의 저장소 장애에 예약이 바로 멈추고('앱을 쓸 수 없어(권한 없음 또는 삭제됨)…') 직원에게 메일이 갔고, 일괄 실행은 묶음 전체가 멈췄다.
 * 이제 지금 못 받은 것은 503(그 차례 실패 — 다음 차례에 다시), 원본이 없는 것은 422(실패로 세고, 연속 3회에 멈춤).
 */

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: { from: () => ({}) } }));

import { loadLibraryDocuments, type LibraryDeps, type LibraryDocumentRow } from '@/lib/apps/library-documents';
import { executeSchedule, PAUSED_APP_UNAVAILABLE, type AppScheduleRow, type ExecuteIo } from '@/lib/apps/schedules';
import type { PreparedTurn } from '@/lib/assistant/types';

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const D1 = '11111111-0000-4000-8000-000000000001';
const actor = { userId: 'me', isAdmin: false, organizationId: 'org', departmentId: 'dept', visibleDepartmentIds: ['dept'], managedDepartmentIds: [], managesWholeOrganization: false } as never;
const doc = (over: Partial<LibraryDocumentRow> = {}): LibraryDocumentRow => ({
  id: D1, agent_id: AGENT, department_id: 'dept', organization_id: 'org', visibility: 'organization', storage_path: `p/${D1}`,
  file_name: '여비규정.hwpx', file_type: 'hwpx', title: '여비 규정', noda_status: 'ready', replaces_id: null, effective_from: null, retired_at: null, ...over,
});
const deps = (download: LibraryDeps['download']): LibraryDeps => ({ documentsOf: async () => [doc()], download, read: vi.fn() as never });

describe('고른 문서 읽기', () => {
  it('원본을 지금 못 받으면 503', async () => {
    expect(await loadLibraryDocuments([D1], AGENT, actor, deps(async () => 'unavailable'))).toEqual({
      ok: false, status: 503, message: '여비 규정: 원본 파일을 지금 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
    });
  });
  it('원본이 없으면 422(404가 아님 — 실행기가 404를 앱 없음으로 읽는다)', async () => {
    expect(await loadLibraryDocuments([D1], AGENT, actor, deps(async () => null))).toMatchObject({ ok: false, status: 422 });
  });
  it('대화 준비의 내려받기가 저장소 오류를 가른다', () => {
    const src = readFileSync('src/lib/assistant/prepare.ts', 'utf8');
    expect(src).toContain("if (error && !isStorageNotFound(error)) return 'unavailable';");
  });
});

describe('예약 실행기가 읽는 거절', () => {
  const row = (): AppScheduleRow => ({
    id: 's1', agent_id: AGENT, user_id: 'u1', department_id: 'd1', organization_id: 'o1', app_version: 3, inputs: { title: '점검' }, document_ids: [D1],
    frequency: 'daily', weekday: null, month_day: null, run_hour: 9, run_minute: 0, status: 'active', paused_reason: null,
    next_run_at: '2026-11-03T00:00:00.000Z', claimed_at: null, last_run_at: null, last_status: null, last_error: null, last_conversation_id: null,
    consecutive_failures: 0, run_count: 0, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z',
  } as AppScheduleRow);
  const io = (status: number, message: string) => ({
    loadUser: vi.fn(async () => ({ id: 'u1', email: null, role: 'USER', department_id: 'd1', is_active: true, deleted_at: null })),
    prepare: vi.fn(async () => ({ ok: false as const, status, message })),
    stream: vi.fn(async (_t: PreparedTurn) => {}),
    retitle: vi.fn(async () => {}),
    documentsOf: vi.fn(async () => [doc({ department_id: 'd1', organization_id: 'o1' })]),
  }) as unknown as ExecuteIo;

  it('503(지금 못 받음)은 그 차례 실패 — 예약을 멈추지 않는다', async () => {
    expect(await executeSchedule(row(), io(503, '여비 규정: 원본 파일을 지금 불러오지 못했습니다.'))).toMatchObject({ kind: 'failed' });
  });
  it('422(원본 없음)도 실패로 센다 — 앱 없음으로 멈추지 않는다', async () => {
    expect(await executeSchedule(row(), io(422, '여비 규정: 원본 파일을 찾을 수 없습니다.'))).toMatchObject({ kind: 'failed' });
  });
  it('404는 여전히 앱을 쓸 수 없음(그래서 문서 원본에 404를 쓰지 않는다)', async () => {
    expect(await executeSchedule(row(), io(404, '비서를 찾을 수 없습니다.'))).toEqual({ kind: 'pause', reason: PAUSED_APP_UNAVAILABLE });
  });
});
