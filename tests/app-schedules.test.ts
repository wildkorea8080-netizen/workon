import { readFileSync } from 'fs';
import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  APP_MAX_SCHEDULES_PER_USER, KST_OFFSET_MS, describeSchedule, nextRunAt, parseScheduleSpec, scheduleView, specOfRow, type AppScheduleSpec,
} from '@/lib/apps/schedule-spec';
import {
  PAUSED_AFTER_FAILURES, PAUSED_APP_CHANGED, PAUSED_APP_UNAVAILABLE, PAUSED_DEPARTMENT_CHANGED, PAUSED_USER_UNAVAILABLE,
  SCHEDULE_BATCH, SCHEDULE_MAX_CONSECUTIVE_FAILURES, SCHEDULE_RUN_BUDGET_MS, SCHEDULE_TITLE_PREFIX,
  executeSchedule, finishPatch, runDueSchedules, type AppScheduleRow, type ExecuteIo, type ScheduleDeps, type ScheduleOutcome,
} from '@/lib/apps/schedules';
import { scheduleFailureMail } from '@/lib/mailer';
import type { PreparedTurn, TurnEvent } from '@/lib/assistant/types';

/** 입력형 앱 예약 실행(0048) — 다음 시각(KST)·실행 결과 반영·차지·멈춤·알림 */
const kst = (text: string) => Date.parse(`${text}+09:00`);
const spec = (patch: Partial<AppScheduleSpec> = {}): AppScheduleSpec => ({ frequency: 'daily', weekday: null, monthDay: null, hour: 9, minute: 0, ...patch });
const row = (patch: Partial<AppScheduleRow> = {}): AppScheduleRow => ({
  id: 's1', agent_id: 'a1', user_id: 'u1', department_id: 'd1', organization_id: 'o1', app_version: 3, inputs: { title: '주간 보고' },
  frequency: 'daily', weekday: null, month_day: null, run_hour: 9, run_minute: 0, status: 'active', paused_reason: null,
  next_run_at: '2026-11-03T00:00:00.000Z', claimed_at: null, last_run_at: null, last_status: null, last_error: null, last_conversation_id: null,
  consecutive_failures: 0, run_count: 0, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z', ...patch,
});

describe('예약 규칙(parseScheduleSpec·describeSchedule)', () => {
  it('매일·평일·매주(요일)·매월(1~28일)과 시각(0~23시, 0·30분)만 받고, 글 숫자도 읽는다', () => {
    expect(parseScheduleSpec({ frequency: 'daily', hour: '9', minute: '0' })).toEqual({ ok: true, value: spec() });
    expect(parseScheduleSpec({ frequency: 'weekly', weekday: 1, hour: 14, minute: 30 })).toEqual({ ok: true, value: spec({ frequency: 'weekly', weekday: 1, hour: 14, minute: 30 }) });
    expect(parseScheduleSpec({ frequency: 'monthly', month_day: 28, hour: 0, minute: 0 })).toEqual({ ok: true, value: spec({ frequency: 'monthly', monthDay: 28, hour: 0 }) });
    for (const bad of [null, { frequency: 'hourly', hour: 9, minute: 0 }, { frequency: 'daily', hour: 24, minute: 0 }, { frequency: 'daily', hour: 9, minute: 15 },
      { frequency: 'weekly', hour: 9, minute: 0 }, { frequency: 'weekly', weekday: 7, hour: 9, minute: 0 }, { frequency: 'monthly', month_day: 31, hour: 9, minute: 0 }, { frequency: 'daily', hour: 9.5, minute: 0 }]) {
      const parsed = parseScheduleSpec(bad); expect(parsed.ok).toBe(false); if (!parsed.ok) expect(parsed.message).toMatch(/주기|시각|요일|날/);
    }
  });
  it('설명 글', () => {
    expect(describeSchedule(spec())).toBe('매일 09:00');
    expect(describeSchedule(spec({ frequency: 'weekdays', hour: 18, minute: 30 }))).toBe('평일 18:30');
    expect(describeSchedule(spec({ frequency: 'weekly', weekday: 1 }))).toBe('매주 월요일 09:00');
    expect(describeSchedule(spec({ frequency: 'monthly', monthDay: 15 }))).toBe('매월 15일 09:00');
    expect(APP_MAX_SCHEDULES_PER_USER).toBe(5);
  });
});

describe('다음 실행 시각(nextRunAt) — 한국 시간', () => {
  it('매일: 오늘 시각이 아직이면 오늘, 지났거나 정확히 그 시각이면 내일', () => {
    expect(nextRunAt(spec(), kst('2026-11-03T08:59:00')).toISOString()).toBe('2026-11-03T00:00:00.000Z');
    expect(nextRunAt(spec(), kst('2026-11-03T09:00:00')).toISOString()).toBe('2026-11-04T00:00:00.000Z');
    expect(nextRunAt(spec(), kst('2026-11-03T20:00:00')).toISOString()).toBe('2026-11-04T00:00:00.000Z');
    // 자정 직후 KST(UTC로는 전날 15시) — 날짜를 KST로 세야 한다
    expect(nextRunAt(spec({ hour: 0, minute: 30 }), kst('2026-11-03T00:10:00')).toISOString()).toBe('2026-11-02T15:30:00.000Z');
    expect(KST_OFFSET_MS).toBe(9 * 3_600_000);
  });
  it('평일: 금요일 뒤는 월요일, 매주: 그 요일, 매월: 그 날(이번 달이 지났으면 다음 달)', () => {
    // 2026-11-06은 금요일
    expect(nextRunAt(spec({ frequency: 'weekdays' }), kst('2026-11-06T10:00:00')).toISOString()).toBe('2026-11-09T00:00:00.000Z'); // 11-09(월) 09:00 KST
    expect(nextRunAt(spec({ frequency: 'weekdays' }), kst('2026-11-07T10:00:00')).toISOString()).toBe('2026-11-09T00:00:00.000Z');
    expect(nextRunAt(spec({ frequency: 'weekdays' }), kst('2026-11-05T08:00:00')).toISOString()).toBe('2026-11-05T00:00:00.000Z'); // 목요일 오늘
    expect(nextRunAt(spec({ frequency: 'weekly', weekday: 3 }), kst('2026-11-03T10:00:00')).toISOString()).toBe('2026-11-04T00:00:00.000Z'); // 11-04(수)
    expect(nextRunAt(spec({ frequency: 'weekly', weekday: 2 }), kst('2026-11-03T08:00:00')).toISOString()).toBe('2026-11-03T00:00:00.000Z'); // 오늘(화) 09:00
    expect(nextRunAt(spec({ frequency: 'monthly', monthDay: 28 }), kst('2026-11-29T00:00:00')).toISOString()).toBe('2026-12-28T00:00:00.000Z');
    expect(nextRunAt(spec({ frequency: 'monthly', monthDay: 1 }), kst('2026-12-31T23:59:00')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
  it('행에서 규칙을 읽고, 화면용 보기는 멈춤·지연을 표시하며 사용자·부서 칸은 내보내지 않는다', () => {
    expect(specOfRow(row({ frequency: 'monthly', month_day: 5, run_hour: 7, run_minute: 30 }))).toEqual(spec({ frequency: 'monthly', monthDay: 5, hour: 7, minute: 30 }));
    const now = Date.parse('2026-11-03T02:00:00Z');
    const view = scheduleView(row(), '주간 보고 앱', now);
    expect(view).toMatchObject({ appName: '주간 보고 앱', description: '매일 09:00', status: 'active', overdue: true, runCount: 0 });
    expect(view).not.toHaveProperty('user_id'); expect(view).not.toHaveProperty('department_id');
    expect(scheduleView(row({ next_run_at: '2026-11-03T01:30:00Z' }), 'x', now).overdue).toBe(false);
    expect(scheduleView(row({ status: 'paused' }), null, now)).toMatchObject({ status: 'paused', overdue: false, appName: '삭제된 앱' });
  });
});

describe('실행 결과 반영(finishPatch)', () => {
  const now = kst('2026-11-03T09:02:00');
  it('완료: 실패 수 0, 대화 id, 다음 시각은 지금 뒤·차지 해제', () => {
    const patch = finishPatch(row({ consecutive_failures: 2, run_count: 4 }), { kind: 'completed', conversationId: 'c1' }, now);
    expect(patch).toMatchObject({ last_status: 'completed', last_error: null, last_conversation_id: 'c1', consecutive_failures: 0, run_count: 5, claimed_at: null, next_run_at: '2026-11-04T00:00:00.000Z' });
    expect(patch.status).toBeUndefined();
  });
  it('실패: 실패 수 +1, 3회째에 멈춤', () => {
    const once = finishPatch(row(), { kind: 'failed', error: '한도 초과' }, now);
    expect(once).toMatchObject({ last_status: 'failed', last_error: '한도 초과', consecutive_failures: 1, next_run_at: '2026-11-04T00:00:00.000Z' });
    expect(once.status).toBeUndefined();
    const third = finishPatch(row({ consecutive_failures: SCHEDULE_MAX_CONSECUTIVE_FAILURES - 1 }), { kind: 'failed', error: 'x'.repeat(400) }, now);
    expect(third).toMatchObject({ status: 'paused', paused_reason: PAUSED_AFTER_FAILURES, consecutive_failures: 3 });
    expect(third.last_error).toHaveLength(300);
  });
  it('멈춤 결과(앱 변경·권한)는 바로 멈추고 이유를 적는다', () => {
    expect(finishPatch(row(), { kind: 'pause', reason: PAUSED_APP_CHANGED }, now)).toMatchObject({ status: 'paused', paused_reason: PAUSED_APP_CHANGED, last_status: 'failed', last_error: PAUSED_APP_CHANGED });
  });
});

function fakeDeps(rows: AppScheduleRow[], outcomes: Record<string, ScheduleOutcome | Error>, patch: Partial<ScheduleDeps> = {}) {
  let clock = kst('2026-11-03T09:01:00');
  const deps = {
    due: vi.fn(async () => rows), claim: vi.fn(async () => true),
    execute: vi.fn(async (r: AppScheduleRow) => { const o = outcomes[r.id]; if (o instanceof Error) throw o; return o; }),
    finish: vi.fn(async () => {}), notifyFailure: vi.fn(async () => {}), log: vi.fn(async () => {}),
    now: vi.fn(() => clock), ...patch,
  };
  // 덮어쓴 칸도 vi.fn이다 — 모두 모의 함수로 본다(덮어쓰기가 Partial<ScheduleDeps>라 그냥 두면 .mock 타입을 잃는다)
  return { deps: deps as unknown as { [K in keyof ScheduleDeps]: ScheduleDeps[K] & Mock<ScheduleDeps[K]> }, advance: (ms: number) => { clock += ms; } };
}

describe('runDueSchedules — 차지한 예약만 하나씩, 한 예약의 실패가 다른 예약을 막지 않는다', () => {
  it('완료·실패·멈춤을 세고, 실패·멈춤만 기록·알림', async () => {
    const rows = [row({ id: 's1' }), row({ id: 's2', consecutive_failures: 2 }), row({ id: 's3' })];
    const { deps } = fakeDeps(rows, { s1: { kind: 'completed', conversationId: 'c1' }, s2: { kind: 'failed', error: '모델 오류' }, s3: { kind: 'pause', reason: PAUSED_APP_CHANGED } });
    const result = await runDueSchedules(deps);
    expect(result).toEqual({ checked: 3, completed: 1, failed: 0, paused: 2, skipped: 0, partial: false });
    expect(deps.due).toHaveBeenCalledWith(expect.any(Number), SCHEDULE_BATCH);
    expect(deps.finish).toHaveBeenCalledTimes(3);
    expect(deps.finish.mock.calls[0]).toEqual(['s1', expect.objectContaining({ last_status: 'completed', last_conversation_id: 'c1' })]);
    expect(deps.finish.mock.calls[1][1]).toMatchObject({ status: 'paused', paused_reason: PAUSED_AFTER_FAILURES });
    expect(deps.notifyFailure).toHaveBeenCalledTimes(2);
    expect(deps.notifyFailure.mock.calls[0]).toEqual([rows[1], { error: '모델 오류', paused: true, nextRunAt: '2026-11-04T00:00:00.000Z' }]);
    expect(deps.notifyFailure.mock.calls[1][1]).toMatchObject({ error: PAUSED_APP_CHANGED, paused: true });
    expect(deps.log).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(deps.log.mock.calls)).not.toContain('주간 보고'); // 입력값은 기록에 안 실림
  });
  it('차지하지 못한 예약은 건너뛰고, 실행이 던지면 실패로 반영하며, 저장·알림 실패는 기록만 남긴다', async () => {
    const rows = [row({ id: 's1' }), row({ id: 's2' }), row({ id: 's3' })];
    const { deps } = fakeDeps(rows, { s2: new Error('DB 끊김'), s3: { kind: 'completed', conversationId: null } }, {
      claim: vi.fn(async (id: string) => id !== 's1'),
      finish: vi.fn(async (id: string) => { if (id === 's3') throw new Error('저장 실패'); }),
      notifyFailure: vi.fn(async () => { throw new Error('메일 실패'); }),
    });
    const result = await runDueSchedules(deps);
    expect(result).toEqual({ checked: 3, completed: 1, failed: 1, paused: 0, skipped: 1, partial: false });
    expect(deps.execute).toHaveBeenCalledTimes(2);
    expect(deps.finish.mock.calls[0]).toEqual(['s2', expect.objectContaining({ last_status: 'failed', last_error: 'DB 끊김', consecutive_failures: 1 })]);
    const messages = deps.log.mock.calls.map(c => c[1]);
    expect(messages).toContain('앱 예약 실패 알림을 보내지 못함');
    expect(messages).toContain('앱 예약 실행 결과를 저장하지 못함');
    expect(deps.log.mock.calls.find(c => c[1] === '앱 예약 실행 결과를 저장하지 못함')?.[0]).toBe('error');
  });
  it('차지가 던져도 다음 예약으로, 시간 예산을 넘기면 남은 예약을 다음 호출에 넘긴다(partial)', async () => {
    const rows = [row({ id: 's1' }), row({ id: 's2' }), row({ id: 's3' })];
    const { deps, advance } = fakeDeps(rows, { s2: { kind: 'completed', conversationId: 'c2' } }, {
      claim: vi.fn(async (id: string) => { if (id === 's1') throw new Error('잠김'); return true; }),
      execute: vi.fn(async () => { advance(SCHEDULE_RUN_BUDGET_MS + 1); return { kind: 'completed', conversationId: 'c2' } as ScheduleOutcome; }),
    });
    const result = await runDueSchedules(deps);
    expect(result).toMatchObject({ checked: 2, completed: 1, partial: true });
    expect(deps.execute).toHaveBeenCalledTimes(1);
    expect(deps.log.mock.calls[0][1]).toBe('앱 예약을 차지하지 못함');
  });
});

describe('executeSchedule — 예약한 직원의 권한으로 대화 실행기를 태운다', () => {
  const user = { id: 'u1', email: 'kim@org.go.kr', role: 'USER', department_id: 'd1', is_active: true, deleted_at: null };
  const turn = { conversationId: 'c1' } as unknown as PreparedTurn;
  function io(patch: Partial<ExecuteIo> = {}, events: TurnEvent[] = [{ event: 'meta', data: { conversation_id: 'c1', chunks: [] } }, { event: 'delta', data: { text: '답' } }, { event: 'done', data: { usage: { model: 'm', input_tokens: 1, output_tokens: 1 }, title: '보고', number_check: null } }]) {
    return {
      loadUser: vi.fn(async () => user), prepare: vi.fn(async () => ({ ok: true as const, turn })),
      stream: vi.fn(async (_turn: PreparedTurn, send: (e: TurnEvent) => void) => { for (const e of events) send(e); }),
      retitle: vi.fn(async () => {}), ...patch,
    } as ExecuteIo & { prepare: ReturnType<typeof vi.fn>; stream: ReturnType<typeof vi.fn>; retitle: ReturnType<typeof vi.fn> };
  }
  it('세션 꼴은 그 직원(id·역할·부서)이고 본문은 손으로 실행할 때와 같다. 끝나면 제목에 [예약]을 붙인다', async () => {
    const fake = io();
    await expect(executeSchedule(row(), fake)).resolves.toEqual({ kind: 'completed', conversationId: 'c1' });
    const [session, body] = fake.prepare.mock.calls[0];
    expect(session.user).toMatchObject({ id: 'u1', role: 'USER', departmentId: 'd1' });
    expect(body).toEqual({ agent_id: 'a1', message: '앱 실행', app_inputs: { title: '주간 보고' }, app_version: 3 });
    expect(fake.retitle).toHaveBeenCalledWith('c1', SCHEDULE_TITLE_PREFIX);
    expect(SCHEDULE_TITLE_PREFIX).toBe('[예약] ');
    const admin = io({ loadUser: vi.fn(async () => ({ ...user, role: 'ADMIN' })) });
    await executeSchedule(row(), admin);
    expect(admin.prepare.mock.calls[0][0].user.role).toBe('ADMIN');
  });
  it('직원 계정을 쓸 수 없거나 부서가 바뀌면 멈춤 — 준비를 부르지 않는다', async () => {
    for (const bad of [null, { ...user, is_active: false }, { ...user, deleted_at: '2026-11-01T00:00:00Z' }]) {
      const fake = io({ loadUser: vi.fn(async () => bad) });
      await expect(executeSchedule(row(), fake)).resolves.toEqual({ kind: 'pause', reason: PAUSED_USER_UNAVAILABLE });
      expect(fake.prepare).not.toHaveBeenCalled();
    }
    const moved = io({ loadUser: vi.fn(async () => ({ ...user, department_id: 'd9' })) });
    await expect(executeSchedule(row(), moved)).resolves.toEqual({ kind: 'pause', reason: PAUSED_DEPARTMENT_CHANGED });
  });
  it('준비 거절: 409(앱 판 바뀜)·403·404는 멈춤, 그 밖(한도 429·검사 400)은 실패 — 스트림은 부르지 않는다', async () => {
    const cases: Array<[number, ScheduleOutcome]> = [
      [409, { kind: 'pause', reason: PAUSED_APP_CHANGED }], [403, { kind: 'pause', reason: PAUSED_APP_UNAVAILABLE }], [404, { kind: 'pause', reason: PAUSED_APP_UNAVAILABLE }],
      [429, { kind: 'failed', error: '한도 초과' }], [400, { kind: 'failed', error: '한도 초과' }],
    ];
    for (const [status, expected] of cases) {
      const fake = io({ prepare: vi.fn(async () => ({ ok: false as const, status, message: '한도 초과' })) });
      await expect(executeSchedule(row(), fake)).resolves.toEqual(expected);
      expect(fake.stream).not.toHaveBeenCalled();
    }
  });
  it('스트림의 error 이벤트·던짐·done 없음은 실패(대화 id는 남김)이고 제목을 바꾸지 않는다', async () => {
    const errored = io({}, [{ event: 'meta', data: { conversation_id: 'c1', chunks: [] } }, { event: 'error', data: { message: '모델 오류' } }, { event: 'done', data: { usage: { model: 'm', input_tokens: 0, output_tokens: 0 }, title: null, number_check: null } }]);
    await expect(executeSchedule(row(), errored)).resolves.toEqual({ kind: 'failed', error: '모델 오류', conversationId: 'c1' });
    expect(errored.retitle).not.toHaveBeenCalled();
    const thrown = io({ stream: vi.fn(async () => { throw new Error('끊김'); }) });
    await expect(executeSchedule(row(), thrown)).resolves.toEqual({ kind: 'failed', error: '끊김', conversationId: null });
    const unfinished = io({}, [{ event: 'meta', data: { conversation_id: 'c1', chunks: [] } }]);
    await expect(executeSchedule(row(), unfinished)).resolves.toMatchObject({ kind: 'failed', conversationId: 'c1' });
    const retitleFails = io({ retitle: vi.fn(async () => { throw new Error('x'); }) });
    await expect(executeSchedule(row(), retitleFails)).resolves.toEqual({ kind: 'completed', conversationId: 'c1' });
  });
});

describe('실패 안내 메일·마이그레이션·실행기 라우트', () => {
  it('메일 글은 앱·예약·이유·다음 실행을 담고 입력값은 담지 않는다. 멈춤이면 다음 실행 대신 다시 켜라는 안내', () => {
    const mail = scheduleFailureMail({ appName: '주간 보고 앱', description: '매일 09:00', error: '한도 초과', paused: false, nextRunAt: '2026-11-04T00:00:00.000Z', schedulesUrl: 'https://x/apps/schedules', failedAt: new Date('2026-11-03T00:02:00Z') });
    expect(mail.subject).toContain('실행 실패'); expect(mail.subject).toContain('주간 보고 앱');
    expect(mail.html).toContain('매일 09:00'); expect(mail.html).toContain('한도 초과'); expect(mail.html).toContain('2026-11-04 09:00'); expect(mail.html).toContain('2026-11-03 09:02');
    expect(mail.html).toContain('https://x/apps/schedules');
    const paused = scheduleFailureMail({ appName: '앱', description: '매일 09:00', error: PAUSED_AFTER_FAILURES, paused: true, nextRunAt: '2026-11-04T00:00:00.000Z', schedulesUrl: 'https://x/apps/schedules', failedAt: new Date() });
    expect(paused.subject).toContain('멈췄습니다'); expect(paused.html).not.toContain('다음 실행'); expect(paused.html).toContain('다시 켜');
  });
  it('0048은 추가만·RLS·권한 회수·주기와 요일/날 짝 CHECK, 실행기 라우트는 서버 예약 비밀값만(없으면 503)·300초', () => {
    const sql = readFileSync('supabase/migrations/0048_app_schedules.sql', 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.app_schedules');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY'); expect(sql).toContain('REVOKE ALL ON public.app_schedules FROM anon, authenticated');
    expect(sql).toContain("CHECK ((frequency = 'weekly') = (weekday IS NOT NULL))"); expect(sql).toContain("CHECK ((frequency = 'monthly') = (month_day IS NOT NULL))");
    expect(sql).toContain('run_minute IN (0, 30)'); expect(sql).toContain('month_day BETWEEN 1 AND 28');
    expect(sql).not.toMatch(/DROP|ALTER TABLE public\.(agents|users|conversations)/);
    const route = readFileSync('src/app/api/cron/app-schedules/route.ts', 'utf8');
    expect(route).toContain('WORK_WORKER_SECRET'); expect(route).toContain('CRON_SECRET'); expect(route).toContain('timingSafeEqual'); expect(route).toContain('status: 503'); expect(route).toContain('maxDuration = 300');
    // Vercel Hobby 예약 작업(2개·하루 한 번)에는 넣지 않는다 — pg_cron이 부른다
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons: { path: string }[] };
    expect(vercel.crons.some(c => c.path === '/api/cron/app-schedules')).toBe(false);
  });
});
