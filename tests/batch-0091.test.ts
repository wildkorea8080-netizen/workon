import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import { runDueSchedules, type AppScheduleRow, type ScheduleDeps, type ScheduleOutcome } from '@/lib/apps/schedules';
import { runDueBatchItems, type BatchDeps, type BatchItemRun } from '@/lib/apps/batches';
import type { RunAsOutcome } from '@/lib/apps/run-as';

/** 2026-11-12 묶음 — 결과 저장 실패가 같은 실행을 다시 돌리지 않게(예약·일괄 실행) */

const row = (patch: Partial<AppScheduleRow> = {}): AppScheduleRow => ({
  id: 's1', agent_id: 'a1', user_id: 'u1', department_id: 'd1', organization_id: 'o1', app_version: 3, inputs: { title: '주간 보고' },
  frequency: 'daily', weekday: null, month_day: null, run_hour: 9, run_minute: 0, status: 'active', paused_reason: null,
  next_run_at: '2026-11-03T00:00:00.000Z', claimed_at: null, last_run_at: null, last_status: null, last_error: null, last_conversation_id: null,
  consecutive_failures: 0, run_count: 4, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z', ...patch,
});

function scheduleDeps(rows: AppScheduleRow[], outcome: ScheduleOutcome, patch: Partial<ScheduleDeps> = {}) {
  const deps: ScheduleDeps = {
    due: vi.fn(async () => rows), claim: vi.fn(async () => true),
    execute: vi.fn(async () => outcome),
    finish: vi.fn(async () => {}), notifyFailure: vi.fn(async () => {}), notifySuccess: vi.fn(async () => {}), exportResult: vi.fn(async () => 'f1'),
    orgDisabled: vi.fn(async () => false), log: vi.fn(async () => {}), now: () => Date.parse('2026-11-03T00:20:00Z'),
    completedSince: vi.fn(async () => null),
    ...patch,
  };
  return deps;
}
const STALE = '2026-11-03T00:01:00.000Z';

describe('예약 — 결과 저장만 실패했던 지난 실행', () => {
  it('멈춘 차지의 실행이 이미 끝까지 마쳤으면 다시 돌리지 않고 마친 것으로 기록(메일·한글 파일 다시 안 함)', async () => {
    const deps = scheduleDeps([row({ claimed_at: STALE, notify_on_success: true, export_hwpx: true } as Partial<AppScheduleRow>)], { kind: 'completed', conversationId: 'new' },
      { completedSince: vi.fn(async () => 'c-prior') });
    const result = await runDueSchedules(deps);
    expect(deps.completedSince).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }), STALE);
    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.notifySuccess).not.toHaveBeenCalled();
    expect(deps.exportResult).not.toHaveBeenCalled();
    expect(result.recovered).toBe(1);
    expect(result.completed).toBe(0);
    const patch = (deps.finish as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(patch).toMatchObject({ claimed_at: null, last_status: 'completed', last_conversation_id: 'c-prior', run_count: 5, consecutive_failures: 0 });
    expect(Date.parse(patch.next_run_at)).toBeGreaterThan(Date.parse('2026-11-03T00:20:00Z'));
  });
  it('마친 실행이 없으면·확인이 던지면 예전처럼 실행(던지면 기록)', async () => {
    const none = scheduleDeps([row({ claimed_at: STALE })], { kind: 'completed', conversationId: 'c1' });
    expect(await runDueSchedules(none)).toMatchObject({ completed: 1 });
    expect(none.execute).toHaveBeenCalledTimes(1);
    const thrown = scheduleDeps([row({ claimed_at: STALE })], { kind: 'completed', conversationId: 'c1' }, { completedSince: vi.fn(async () => { throw new Error('db'); }) });
    expect(await runDueSchedules(thrown)).toMatchObject({ completed: 1 });
    expect(thrown.log).toHaveBeenCalledWith('warning', '앱 예약 지난 실행을 확인하지 못함', expect.objectContaining({ schedule_id: 's1' }), 'o1');
  });
  it('처음 차지(claimed_at 없음)·이어 가는 실행(0074)은 확인하지 않는다', async () => {
    const fresh = scheduleDeps([row()], { kind: 'completed', conversationId: 'c1' });
    await runDueSchedules(fresh);
    expect(fresh.completedSince).not.toHaveBeenCalled();
    const resume = scheduleDeps([row({ claimed_at: STALE, resume_message_id: 'm1', resume_count: 1 })], { kind: 'completed', conversationId: 'c1' }, { completedSince: vi.fn(async () => 'c-prior') });
    await runDueSchedules(resume);
    expect(resume.completedSince).not.toHaveBeenCalled();
    expect(resume.execute).toHaveBeenCalledTimes(1);
  });
  it('결과 저장은 한 번 더 해 보고, 그래도 안 되면 기록만', async () => {
    let calls = 0;
    const once = scheduleDeps([row()], { kind: 'completed', conversationId: 'c1' }, { finish: vi.fn(async () => { if (++calls === 1) throw new Error('잠깐'); }) });
    await runDueSchedules(once);
    expect(once.finish).toHaveBeenCalledTimes(2);
    expect(once.log).not.toHaveBeenCalledWith('error', '앱 예약 실행 결과를 저장하지 못함', expect.anything(), 'o1');
    const never = scheduleDeps([row()], { kind: 'completed', conversationId: 'c1' }, { finish: vi.fn(async () => { throw new Error('db'); }) });
    expect(await runDueSchedules(never)).toMatchObject({ completed: 1 });
    expect(never.finish).toHaveBeenCalledTimes(2);
    expect(never.log).toHaveBeenCalledWith('error', '앱 예약 실행 결과를 저장하지 못함', expect.objectContaining({ outcome: 'completed' }), 'o1');
  });
  it('연결(원본) — 마친 실행의 대화에 도장, 찾기는 그 직원·그 앱·그 예약의 도장·차지 이후만', () => {
    const lib = readFileSync('src/lib/apps/schedules.ts', 'utf8');
    expect(lib).toContain('await stampScheduleRun(conversationId, row.id, Date.now()).catch(() => undefined);');
    expect(lib).toContain('completedSince: findCompletedScheduleRun,');
    expect(lib).toContain(".eq('user_id', row.user_id).eq('agent_id', row.agent_id)");
    expect(lib).toContain(".eq('metadata->app_schedule->>id', row.id).gte('metadata->app_schedule->>finished_at', since.toISOString())");
    expect(lib).toContain('app_schedule: { id: scheduleId, finished_at: new Date(nowMs).toISOString() }');
  });
});

describe('일괄 실행 — 줄 결과 저장', () => {
  const batch = { id: 'b1', organization_id: 'o1', department_id: 'd1', user_id: 'u1', agent_id: 'a1', app_version: 2, status: 'running' as const };
  const item = (position: number): BatchItemRun => ({ id: `i${position}`, batch_id: 'b1', position, inputs: { topic: 'q' }, status: 'pending', attempts: 0, claimed_at: null, batch });
  function deps(finishItem: BatchDeps['finishItem']) {
    const d: BatchDeps = {
      now: () => 0, openItems: async () => [item(1), item(2)], claim: async () => true,
      run: async () => ({ kind: 'completed', conversationId: 'c', messageId: 'm' } as RunAsOutcome),
      finishItem, stop: async () => true, settle: async () => false, log: vi.fn(async () => {}),
    };
    return d;
  }
  it('한 번 실패하면 다시 해 보고, 두 번 실패하면 기록하고 다음 줄로', async () => {
    const tries = new Map<string, number>();
    const flaky = deps(vi.fn(async (id: string) => { const n = (tries.get(id) ?? 0) + 1; tries.set(id, n); if (n === 1) throw new Error('잠깐'); }));
    expect(await runDueBatchItems(flaky)).toMatchObject({ ran: 2, done: 2 });
    expect(flaky.finishItem).toHaveBeenCalledTimes(4);
    expect(flaky.log).not.toHaveBeenCalled();
    const broken = deps(vi.fn(async () => { throw new Error('db'); }));
    expect(await runDueBatchItems(broken)).toMatchObject({ ran: 2 });
    expect(broken.log).toHaveBeenCalledWith('앱 일괄 실행 줄 결과를 저장하지 못했습니다', expect.objectContaining({ item_id: 'i1', status: 'done' }), 'o1');
  });
  it('연결(원본) — DB 오류를 삼키지 않고 던진다(예전엔 조용히 넘어가 줄이 running으로 남았다)', () => {
    expect(readFileSync('src/lib/apps/batches.ts', 'utf8')).toContain("if (error) throw new Error(`app_batch_items finish: ${error.message}`);");
  });
});
