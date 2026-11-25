import { describe, expect, it, vi } from 'vitest';
import { renderAppInput, type AppDefinition, type AppStep } from '@/lib/apps/definition';
import { APP_LOOP_FEEDBACK_NOTE, runAppIntermediateSteps, type AppStepRecord } from '@/lib/apps/pipeline';
import { hasResumableProgress, restoreAppSteps } from '@/lib/apps/resume';
import type { LlmRequest } from '@/lib/llm/types';

/**
 * 2026-11-25 — 되돌아간 실행의 이어 실행. 되돌아간 횟수(`looped`)와 되돌아온 까닭(`loopFeedback` — 되돌아가 다시 하는 동안 되돌아오게 한
 * 단계의 기록에 남음)을 기록에 남겨, 멈춘 실행을 이어 갈 때 남은 횟수와 참고 자료를 그대로 이어 받는다.
 */

const fields = [
  { key: 'kind', label: '종류', type: 'select' as const, required: true, options: ['보통', '꼼꼼'] },
  { key: 'body', label: '내용', type: 'textarea' as const, required: true },
];
const needsFix = { all: [{ field: '@2', op: 'equals' as const, value: '고칠 점 있음' }] };
const steps: AppStep[] = [
  { name: '초안', instruction: '초안을 쓴다' },
  { name: '검토', instruction: '규정에 맞는지 본다', classify: { options: ['통과', '고칠 점 있음'] } },
  { name: '고칠 점 정리', instruction: '검토 결과를 정리', branches: [{ name: '다시 쓰기', when: needsFix, instruction: '고칠 점을 목록으로', back: 1, rounds: 2 }] },
  { name: '최종', instruction: '최종 회신을 쓴다' },
];
const def: AppDefinition = { schemaVersion: 1, fields, output: 'paragraphs', steps };
const inputs = { kind: '보통', body: 'x' };
const input = renderAppInput(def, inputs); if (!input.ok) throw Error('fixture');

/** 분류 답은 차례대로(다 쓰면 마지막 것), `failAt`번째 호출에서 던진다 */
function setup(records: AppStepRecord[], answers: string[], failAt = 0) {
  const calls: LlmRequest[] = [];
  let n = 0; let c = 0;
  const complete = vi.fn(async (req: LlmRequest) => {
    calls.push(req);
    if (failAt && calls.length === failAt) throw new Error('모델 장애');
    const text = (req.system ?? '').includes('(분류)') ? answers[Math.min(c++, answers.length - 1)] : `결과 ${++n}`;
    return { text, usage: { model: 'm', input_tokens: 10, output_tokens: 4 } };
  });
  return {
    calls,
    args: {
      steps, records, model: 'm', system: '역할', messages: [{ role: 'user' as const, content: input.ok ? input.message : '' }], inputs,
      usage: { model: 'm', input_tokens: 0, output_tokens: 0 }, guard: vi.fn(async () => {}), update: vi.fn(), complete,
    },
  };
}
const fresh = () => steps.map((s) => ({ name: s.name, status: 'pending' as const })) as AppStepRecord[];
/** 대화 실행기가 멈춘 실행을 저장하는 꼴(stream.ts) — 돌던 단계는 failed, 기다리던 단계는 not_run */
const saveAsStopped = (records: AppStepRecord[]) => records.map((r) => ({ ...r, status: r.status === 'running' ? 'failed' : r.status === 'pending' ? 'not_run' : r.status }));

describe('되돌아간 뒤 멈춘 실행', () => {
  it('되돌아가 다시 하는 동안 멈추면 되돌아오게 한 단계의 기록에 횟수와 까닭이 남는다', async () => {
    const records = fresh();
    const { args } = setup(records, ['고칠 점 있음'], 5); // 초안·검토·정리(되돌아감)·초안 다음 검토에서 멈춤
    await expect(runAppIntermediateSteps(args as never)).rejects.toThrow('모델 장애');
    const saved = saveAsStopped(records);
    expect(saved.map((r) => r.status)).toEqual(['completed', 'failed', 'not_run', 'not_run']);
    expect(saved[2]).toMatchObject({ looped: 1, loopFeedback: '결과 2' });
    expect(saved[0].output).toBe('결과 3');
    expect(hasResumableProgress({ app_inputs: inputs, app_steps: saved })).toBe(true);
  });

  it('이어 실행은 끝난 단계를 다시 쓰고, 되돌아온 까닭을 넘겨 멈춘 자리부터 — 통과하면 최종으로', async () => {
    const records = fresh();
    await runAppIntermediateSteps(setup(records, ['고칠 점 있음'], 5).args as never).catch(() => {});
    const restored = restoreAppSteps(def, { app_inputs: inputs, app_steps: saveAsStopped(records) }, input.message);
    if (!restored.ok) throw new Error(restored.message);
    expect(restored.records).toMatchObject([{ status: 'completed', reused: true, output: '결과 3' }, { status: 'pending' }, { status: 'pending', looped: 1, loopFeedback: '결과 2' }, { status: 'pending' }]);
    const { args, calls } = setup(restored.records, ['통과']);
    const result = await runAppIntermediateSteps(args as never);
    expect(args.complete).toHaveBeenCalledTimes(2); // 검토(통과)·정리(기본 지시)
    expect(JSON.stringify(calls[0].messages)).toContain(APP_LOOP_FEEDBACK_NOTE);
    expect(JSON.stringify(calls[0].messages)).toContain('결과 2');
    expect(restored.records[2]).toMatchObject({ status: 'completed', looped: 1 });
    expect(restored.records[2].loopFeedback).toBeUndefined();
    expect(JSON.stringify(result.messages)).not.toContain(APP_LOOP_FEEDBACK_NOTE);
  });

  it('남은 횟수도 이어 받는다 — 2번 중 1번 썼으면 1번만 더 되돌아간다', async () => {
    const records = fresh();
    await runAppIntermediateSteps(setup(records, ['고칠 점 있음'], 5).args as never).catch(() => {});
    const restored = restoreAppSteps(def, { app_inputs: inputs, app_steps: saveAsStopped(records) }, input.message);
    if (!restored.ok) throw new Error(restored.message);
    const { args } = setup(restored.records, ['고칠 점 있음']);
    await runAppIntermediateSteps(args as never);
    // 검토·정리(되돌아감 — 2번째) → 초안·검토·정리(횟수를 다 씀)
    expect(args.complete).toHaveBeenCalledTimes(5);
    expect(restored.records[2]).toMatchObject({ status: 'completed', looped: 2, branch: '다시 쓰기' });
  });
});

describe('이어 실행 검사 — 되돌아간 기록의 꼴', () => {
  const refs = (s: Array<Record<string, unknown>>) => ({ app_inputs: inputs, app_steps: s.map((x, i) => ({ name: steps[i].name, ...x })) });
  const base = [{ status: 'completed', output: '초안' }, { status: 'failed' }, { status: 'not_run' }, { status: 'not_run' }] as Array<Record<string, unknown>>;
  const withThird = (extra: Record<string, unknown>, at = 2) => refs(base.map((s, i) => (i === at ? { ...s, ...extra } : s)));
  const rejected = { ok: false, message: '되돌아간 단계의 기록이 현재 앱과 다릅니다. 새로 실행해 주세요.' };
  it('받는다 — 되돌아갈 수 있는 단계의 횟수·끝나지 않은 단계의 까닭', () => {
    expect(restoreAppSteps(def, withThird({ looped: 2, loopFeedback: '고칠 점' }), input.message)).toMatchObject({ ok: true });
  });
  it('거절 — 되돌아갈 수 없는 단계·정수 아님·0·상한 넘음·끝난 단계의 까닭·횟수 없는 까닭·빈 까닭', () => {
    expect(restoreAppSteps(def, withThird({ looped: 1 }, 1), input.message)).toEqual(rejected);
    expect(restoreAppSteps(def, withThird({ looped: 1.5 }), input.message)).toEqual(rejected);
    expect(restoreAppSteps(def, withThird({ looped: 0 }), input.message)).toEqual(rejected);
    expect(restoreAppSteps(def, withThird({ looped: 4 }), input.message)).toEqual(rejected);
    expect(restoreAppSteps(def, withThird({ loopFeedback: '까닭' }), input.message)).toEqual(rejected);
    expect(restoreAppSteps(def, withThird({ looped: 1, loopFeedback: '   ' }), input.message)).toEqual(rejected);
    expect(restoreAppSteps(def, withThird({ looped: 1, loopFeedback: 'x'.repeat(12001) }), input.message)).toEqual(rejected);
    const doneWithFeedback = refs([{ status: 'completed', output: '초안' }, { status: 'completed', output: '통과', kind: 'classify' }, { status: 'completed', output: '정리', looped: 1, loopFeedback: '까닭' }, { status: 'failed' }]);
    expect(restoreAppSteps(def, doneWithFeedback, input.message)).toEqual(rejected);
  });
});
