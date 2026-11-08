import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import {
  PAUSED_AFTER_FAILURES, PAUSED_APP_UNAVAILABLE, RESUMING_NOTE, RESUME_REJECTED, SCHEDULE_MAX_RESUMES,
  canAutoResume, executeSchedule, finishPatch, heldPatch, runDueSchedules, type AppScheduleRow, type ExecuteIo, type ScheduleDeps, type ScheduleOutcome,
} from '@/lib/apps/schedules';
import { hasResumableProgress } from '@/lib/apps/resume';
import type { PreparedTurn, TurnEvent } from '@/lib/assistant/types';

/** 앱 예약의 자동 이어 실행(0074) — 멈춘 실행에 끝난 단계가 남았으면 다음 실행기 차례에 이어 간다 */

const MSG = '11111111-2222-4333-8444-555555555555';
const row = (patch: Partial<AppScheduleRow> = {}): AppScheduleRow => ({
  id: 's1', agent_id: 'a1', user_id: 'u1', department_id: 'd1', organization_id: 'o1', app_version: 3, inputs: { title: '주간 보고' },
  frequency: 'daily', weekday: null, month_day: null, run_hour: 9, run_minute: 0, status: 'active', paused_reason: null,
  next_run_at: '2026-11-03T00:00:00.000Z', claimed_at: null, last_run_at: null, last_status: null, last_error: null, last_conversation_id: null,
  consecutive_failures: 0, run_count: 4, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z', ...patch,
});
const NOW = Date.parse('2026-11-08T03:00:00.000Z');

describe('hasResumableProgress — 이어 갈 진행이 남은 기록', () => {
  const steps = (...s: Array<Record<string, unknown>>) => ({ app_inputs: { title: 'x' }, app_steps: s });
  it('재개용 입력과 끝난 단계(또는 반복 도중 끝난 줄)가 있고 멈춘 단계가 있어야', () => {
    expect(hasResumableProgress(steps({ status: 'completed', output: 'a' }, { status: 'failed' }, { status: 'not_run' }))).toBe(true);
    expect(hasResumableProgress(steps({ status: 'failed', partial: ['줄 1'] }, { status: 'not_run' }))).toBe(true);
    expect(hasResumableProgress(steps({ status: 'failed' }, { status: 'not_run' }))).toBe(false); // 끝난 것이 없음
    expect(hasResumableProgress(steps({ status: 'completed' }, { status: 'completed' }))).toBe(false); // 멈춘 것이 없음
    expect(hasResumableProgress({ app_steps: [{ status: 'completed' }, { status: 'failed' }] })).toBe(false); // 입력 저장 없음(자료·도구 실행)
    expect(hasResumableProgress(null)).toBe(false);
    expect(hasResumableProgress([])).toBe(false);
  });
});

describe('finishPatch·heldPatch — 이어 감', () => {
  it("'이어 감'은 다음 실행기 차례로(지금), 실패 수 그대로, 이어 갈 기록·횟수를 적는다", () => {
    const patch = finishPatch(row({ consecutive_failures: 1 }), { kind: 'resume', messageId: MSG, conversationId: 'c1', error: '처리 시간이 길어 멈춤' }, NOW);
    expect(patch).toMatchObject({
      next_run_at: new Date(NOW).toISOString(), claimed_at: null, last_status: 'failed', last_error: RESUMING_NOTE, last_conversation_id: 'c1',
      resume_message_id: MSG, resume_count: 1, run_count: 5,
    });
    expect(patch).not.toHaveProperty('consecutive_failures');
    expect(patch).not.toHaveProperty('status');
    expect(finishPatch(row({ resume_count: 1, resume_message_id: MSG }), { kind: 'resume', messageId: 'm2', conversationId: 'c2', error: 'x' }, NOW).resume_count).toBe(2);
  });
  it('이어 가던 차례가 끝나면(완료·실패·멈춤) 칸을 비우고 다음 정해진 시각으로 — 비어 있던 예약은 칸을 쓰지 않는다', () => {
    const resuming = row({ resume_message_id: MSG, resume_count: 2 });
    for (const outcome of [{ kind: 'completed', conversationId: 'c3' }, { kind: 'failed', error: 'x' }, { kind: 'pause', reason: 'y' }] as ScheduleOutcome[]) {
      const patch = finishPatch(resuming, outcome, NOW);
      expect(patch).toMatchObject({ resume_message_id: null, resume_count: 0 });
      expect(Date.parse(patch.next_run_at!)).toBeGreaterThan(NOW);
    }
    expect(finishPatch(row(), { kind: 'completed', conversationId: 'c' }, NOW)).not.toHaveProperty('resume_message_id');
    expect(heldPatch(resuming, NOW)).toMatchObject({ resume_message_id: null, resume_count: 0 });
    expect(heldPatch(row(), NOW)).not.toHaveProperty('resume_count');
  });
  it('이어 실행이 거절된 실패는 곧(지금) 처음부터, 실패 수는 센다 — 연속 3회면 평소처럼 멈춤', () => {
    const patch = finishPatch(row({ resume_message_id: MSG, resume_count: 1 }), { kind: 'failed', error: RESUME_REJECTED('중단 기록을 찾을 수 없습니다.'), restartSoon: true }, NOW);
    expect(patch).toMatchObject({ next_run_at: new Date(NOW).toISOString(), consecutive_failures: 1, resume_message_id: null, resume_count: 0 });
    expect(finishPatch(row({ consecutive_failures: 2 }), { kind: 'failed', error: 'x', restartSoon: true }, NOW)).toMatchObject({ status: 'paused', paused_reason: PAUSED_AFTER_FAILURES });
  });
});

describe('executeSchedule — 멈추면 이어 감, 이어 가는 차례는 이어 실행 요청', () => {
  const user = { id: 'u1', email: 'kim@org.go.kr', role: 'USER', department_id: 'd1', is_active: true, deleted_at: null };
  const turn = { conversationId: 'c1' } as unknown as PreparedTurn;
  const stopped: TurnEvent[] = [{ event: 'meta', data: { conversation_id: 'c1', chunks: [] } }, { event: 'error', data: { message: '처리 시간이 길어 여기서 멈췄습니다.' } }];
  const finished: TurnEvent[] = [{ event: 'meta', data: { conversation_id: 'c2', chunks: [] } }, { event: 'done', data: { usage: { model: 'm', input_tokens: 1, output_tokens: 1 }, title: '보고', number_check: null } }];
  function io(events: TurnEvent[], patch: Partial<ExecuteIo> = {}) {
    return {
      loadUser: vi.fn(async () => user), prepare: vi.fn(async () => ({ ok: true as const, turn })),
      stream: vi.fn(async (_t: PreparedTurn, send: (e: TurnEvent) => void) => { for (const e of events) send(e); }),
      retitle: vi.fn(async () => {}), resumableMessage: vi.fn(async () => MSG), ...patch,
    } as ExecuteIo & { prepare: ReturnType<typeof vi.fn>; resumableMessage: ReturnType<typeof vi.fn> };
  }

  it('멈춘 실행의 마지막 답변에 진행이 남았으면 이어 감(그 직원의 대화에서 찾음)', async () => {
    const fake = io(stopped);
    await expect(executeSchedule(row(), fake)).resolves.toEqual({ kind: 'resume', messageId: MSG, conversationId: 'c1', error: '처리 시간이 길어 여기서 멈췄습니다.' });
    expect(fake.resumableMessage).toHaveBeenCalledWith('c1', 'u1');
  });
  it('이어 가지 않는 경우 — 진행이 없음·찾기를 못 함·파일·문서가 있는 예약·이번 차례 상한·찾기 함수가 없음(옛 실행기)', async () => {
    const failed = { kind: 'failed', error: '처리 시간이 길어 여기서 멈췄습니다.', conversationId: 'c1' };
    await expect(executeSchedule(row(), io(stopped, { resumableMessage: vi.fn(async () => null) }))).resolves.toEqual(failed);
    await expect(executeSchedule(row(), io(stopped, { resumableMessage: vi.fn(async () => { throw new Error('db'); }) }))).resolves.toEqual(failed);
    const capped = io(stopped);
    await expect(executeSchedule(row({ resume_count: SCHEDULE_MAX_RESUMES }), capped)).resolves.toMatchObject({ kind: 'failed' });
    const old = io(stopped, { resumableMessage: undefined });
    await expect(executeSchedule(row(), old)).resolves.toEqual(failed);
    expect(canAutoResume(row({ files: [{ id: '22222222-2222-4222-8222-222222222222', name: 'a.xlsx', size: 1, path: 'app-schedule-files/o1/u1/x.xlsx' }] }))).toBe(false);
    expect(canAutoResume(row({ document_ids: ['d9'] }))).toBe(false);
    expect(canAutoResume(row())).toBe(true);
  });
  it('이어 가는 차례 — 손 이어 실행과 같은 본문(resume_message_id), 문서·파일 없이, 끝나면 완료', async () => {
    const fake = io(finished);
    await expect(executeSchedule(row({ resume_message_id: MSG, resume_count: 1 }), fake)).resolves.toEqual({ kind: 'completed', conversationId: 'c2' });
    expect(fake.prepare.mock.calls[0][1]).toEqual({ agent_id: 'a1', message: '앱 실행', app_inputs: { title: '주간 보고' }, app_version: 3, resume_message_id: MSG });
  });
  it('이어 간 실행도 멈추면 상한 안에서 또 이어 가고, 이어 실행이 거절되면 곧 처음부터(앱을 쓸 수 없으면 멈춤)', async () => {
    await expect(executeSchedule(row({ resume_message_id: MSG, resume_count: 1 }), io(stopped, { resumableMessage: vi.fn(async () => 'm2') }))).resolves.toMatchObject({ kind: 'resume', messageId: 'm2' });
    for (const [status, message] of [[404, '중단 기록을 찾을 수 없습니다.'], [409, '앱 설정이 바뀌어 이전 결과를 재사용할 수 없습니다. 새로 실행해 주세요.'], [429, '한도']] as const) {
      const rejected = io(finished, { prepare: vi.fn(async () => ({ ok: false as const, status, message })) });
      await expect(executeSchedule(row({ resume_message_id: MSG, resume_count: 1 }), rejected)).resolves.toEqual({ kind: 'failed', error: RESUME_REJECTED(message), restartSoon: true });
    }
    const gone = io(finished, { prepare: vi.fn(async () => ({ ok: false as const, status: 403, message: '권한 없음' })) });
    await expect(executeSchedule(row({ resume_message_id: MSG }), gone)).resolves.toEqual({ kind: 'pause', reason: PAUSED_APP_UNAVAILABLE });
  });
});

describe('runDueSchedules — 이어 감은 실패로 세지 않고 실패 메일도 없다', () => {
  it('이어 감을 따로 세고 info로만 기록', async () => {
    const finish = vi.fn(async () => {});
    const notifyFailure = vi.fn(async () => {});
    const log = vi.fn(async () => {});
    const deps: ScheduleDeps = {
      due: async () => [row()], claim: async () => true, finish, notifyFailure, log, now: () => NOW,
      execute: async () => ({ kind: 'resume', messageId: MSG, conversationId: 'c1', error: '멈춤' }),
      orgDisabled: async () => false, notifySuccess: async () => {}, exportResult: async () => null,
    };
    const result = await runDueSchedules(deps);
    expect(result).toMatchObject({ checked: 1, completed: 0, failed: 0, paused: 0, continued: 1 });
    expect(notifyFailure).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith('s1', expect.objectContaining({ resume_message_id: MSG, resume_count: 1 }));
    expect(log).toHaveBeenCalledWith('info', expect.any(String), expect.objectContaining({ resume_count: 1 }), 'o1');
  });
});

describe('연결·마이그레이션 (원본)', () => {
  it('실행기는 이어 갈 기록 찾기를 붙여 실행하고, 고치기·다시 켜기는 이어 실행 칸을 비운다', () => {
    expect(readFileSync('src/lib/apps/schedules.ts', 'utf8')).toContain('executeSchedule(row, { ...defaultRunAsIo(), resumableMessage: findResumableMessage }, deadlineAt)');
    const route = readFileSync('src/app/api/apps/schedules/[id]/route.ts', 'utf8');
    expect(route.match(/resume_message_id: null, resume_count: 0/g)?.length).toBe(2);
    expect(readFileSync('src/lib/apps/run-as.ts', 'utf8')).toContain('resume_message_id: input.resumeMessageId');
  });
  it('0074 — 칸 둘·횟수 범위 CHECK·여러 번 적용 안전', () => {
    const sql = readFileSync('supabase/migrations/0074_app_schedule_resume.sql', 'utf8');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS resume_message_id uuid');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS resume_count smallint NOT NULL DEFAULT 0');
    expect(sql).toContain("conname = 'app_schedules_resume_count_range'");
  });
});
