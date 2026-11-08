import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import type { AppDefinition } from '@/lib/apps/definition';
import type { AppStepRecord } from '@/lib/apps/pipeline';
import { APP_AUTO_RESUME_MAX, appResumeProgress, autoResumeDecision, autoResumeStatus, type AutoResumeInput } from '@/lib/apps/auto-resume';
import { APP_TIME_BUDGET_CODE, AppStreamError, readAppStream } from '@/lib/apps/stream';

/** 손 실행의 자동 이어 실행(2026-11-08) — 실행 화면이 처리 시간에 멈춘 실행을 끝난 단계부터 곧바로 이어 간다 */

const definition: AppDefinition = {
  schemaVersion: 1, output: 'paragraphs',
  fields: [{ key: 'items', label: '질의', type: 'textarea', required: true }],
  steps: [{ name: '정리', instruction: '정리' }, { name: '검토', instruction: '검토' }, { name: '회신', instruction: '회신' }],
};
const values = { items: '하나\n둘' };
const records = (...statuses: AppStepRecord['status'][]): AppStepRecord[] => statuses.map((status, i) => ({ name: `단계 ${i + 1}`, status, ...(status === 'completed' ? { output: '결과' } : {}) }));
const base = (over: Partial<AutoResumeInput> = {}): AutoResumeInput => ({
  code: APP_TIME_BUDGET_CODE,
  source: { id: 'm1', conversationId: 'c1', inputs: values, records: records('completed', 'failed', 'not_run') },
  definition, values, filesAdded: false, draft: false, attempt: 0, previousProgress: -1, ...over,
});

describe('스트림의 오류 코드', () => {
  const stream = (text: string) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } });
  it('error 사건의 code를 AppStreamError로 넘긴다(없으면 undefined)', async () => {
    const withCode = await readAppStream(stream('event: error\ndata: {"message":"멈춤","code":"app_time_budget"}\n\n'), () => {}).catch((e: unknown) => e);
    expect(withCode).toBeInstanceOf(AppStreamError);
    expect((withCode as AppStreamError).message).toBe('멈춤');
    expect((withCode as AppStreamError).code).toBe(APP_TIME_BUDGET_CODE);
    const without = await readAppStream(stream('event: error\ndata: {"message":"실패"}\n\n'), () => {}).catch((e: unknown) => e);
    expect((without as AppStreamError).code).toBeUndefined();
    const odd = await readAppStream(stream('event: error\ndata: {"message":"실패","code":3}\n\n'), () => {}).catch((e: unknown) => e);
    expect((odd as AppStreamError).code).toBeUndefined();
  });
});

describe('진행의 크기', () => {
  it('끝난 단계가 먼저, 같으면 반복이 끝낸 줄 수', () => {
    expect(appResumeProgress(records('failed', 'not_run'))).toBe(0);
    const partial: AppStepRecord[] = [{ name: '줄마다', status: 'failed', partial: ['a', 'b', 'c'] }, { name: '회신', status: 'not_run' }];
    expect(appResumeProgress(partial)).toBe(3);
    expect(appResumeProgress(records('completed', 'failed'))).toBeGreaterThan(appResumeProgress([{ name: 'x', status: 'failed', partial: Array(8).fill('줄') }]));
    expect(appResumeProgress(records('completed', 'completed', 'failed'))).toBeGreaterThan(appResumeProgress(records('completed', 'failed', 'not_run')));
  });
});

describe('자동으로 이어 갈지', () => {
  it('처리 시간에 멈췄고 끝난 단계가 있으면 그 답변부터 이어 간다', () => {
    expect(autoResumeDecision(base())).toEqual({ resume: true, messageId: 'm1', attempt: 1, progress: 1000 });
  });
  it('처리 시간이 아닌 오류·이어 갈 기록 없음·시험 판·붙인 파일이면 이어 가지 않는다', () => {
    expect(autoResumeDecision(base({ code: undefined })).resume).toBe(false);
    expect(autoResumeDecision(base({ code: 'other' })).resume).toBe(false);
    expect(autoResumeDecision(base({ source: null })).resume).toBe(false);
    expect(autoResumeDecision(base({ draft: true })).resume).toBe(false);
    expect(autoResumeDecision(base({ filesAdded: true })).resume).toBe(false);
  });
  it('입력이 원래 입력과 다르거나 읽히지 않으면 이어 가지 않는다', () => {
    expect(autoResumeDecision(base({ values: { items: '셋' } })).resume).toBe(false);
    expect(autoResumeDecision(base({ values: {} })).resume).toBe(false);
  });
  it(`한 번 누름에 ${APP_AUTO_RESUME_MAX}번까지`, () => {
    expect(autoResumeDecision(base({ attempt: APP_AUTO_RESUME_MAX - 1, previousProgress: 0 })).resume).toBe(true);
    expect(autoResumeDecision(base({ attempt: APP_AUTO_RESUME_MAX, previousProgress: 0 })).resume).toBe(false);
  });
  it('끝난 것이 없거나 직전보다 진행이 늘지 않으면 멈춘다(같은 자리에서 되풀이하지 않게)', () => {
    expect(autoResumeDecision(base({ source: { id: 'm1', conversationId: 'c1', inputs: values, records: records('failed', 'not_run', 'not_run') } })).resume).toBe(false);
    expect(autoResumeDecision(base({ attempt: 1, previousProgress: 1000 })).resume).toBe(false);
    const more = base({ attempt: 1, previousProgress: 1000, source: { id: 'm2', conversationId: 'c2', inputs: values, records: records('completed', 'completed', 'failed') } });
    expect(autoResumeDecision(more)).toEqual({ resume: true, messageId: 'm2', attempt: 2, progress: 2000 });
  });
  it('안내 문구에 몇 번째인지 적는다', () => {
    expect(autoResumeStatus(1)).toContain(`(1/${APP_AUTO_RESUME_MAX})`);
  });
});

describe('실행 화면 연결', () => {
  const page = readFileSync('src/app/apps/run/page.tsx', 'utf8');
  it('멈춘 실행을 다시 읽은 뒤 판단하고, 이어 갈 때는 오류 대신 안내를 보이고 끝난 뒤 다시 부른다', () => {
    expect(page).toContain('autoResumeDecision({ code: failure instanceof AppStreamError ? failure.code : undefined, source, definition, values, filesAdded, draft: Boolean(draftSavedAt)');
    expect(page).toContain('if (next) void run(undefined, next.messageId, { attempt: next.attempt, progress: next.progress });');
    // 다시 부르기는 finally(pending 풀기) 뒤에 — 앞에서 부르면 pending에 막힌다
    expect(page.indexOf('finally { pending.current = false; setRunning(false); }')).toBeLessThan(page.indexOf('if (next) void run('));
  });
  it('대화 실행기는 재개용 입력을 저장한 처리 시간 멈춤에만 코드를 붙인다', () => {
    const stream = readFileSync('src/lib/assistant/stream.ts', 'utf8');
    expect(stream).toContain("error instanceof AppInputError && error.message === APP_TIME_BUDGET_MESSAGE && Boolean(savedInputs)");
  });
});
