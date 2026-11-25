import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  APP_LOOP_ROUNDS_MAX, APP_LOOPS_PER_RUN, branchBackIndex, branchRounds, renderAppInput, validateAppDefinition,
  type AppDefinition, type AppStep,
} from '@/lib/apps/definition';
import { APP_LOOP_FEEDBACK_NOTE, runAppIntermediateSteps, type AppStepRecord } from '@/lib/apps/pipeline';
import { hasResumableProgress, restoreAppSteps } from '@/lib/apps/resume';
import { estimateAppCalls } from '@/lib/apps/call-estimate';
import AppStepEditor from '@/components/apps/AppStepEditor';
import AppStepResults from '@/components/apps/AppStepResults';
import type { LlmRequest } from '@/lib/llm/types';

/**
 * 2026-11-25 — 갈래의 되돌아가기(앱의 뒤로 가는 고리). 갈래로 처리한 뒤 이 단계 또는 앞 단계로 되돌아가 거기서부터 다시 하고,
 * 되돌아오게 한 단계의 결과를 다시 하는 단계들에 참고 자료로 넘긴다. 갈래마다 1~3번, 한 실행에 합쳐 3번까지.
 * 되돌아간 실행은 이어 실행하지 않는다(기록이 마지막 차례만 남는다)
 */

const fields = [
  { key: 'kind', label: '종류', type: 'select' as const, required: true, options: ['보통', '꼼꼼'] },
  { key: 'body', label: '내용', type: 'textarea' as const, required: true },
];
const careful = { all: [{ field: 'kind', op: 'equals' as const, value: '꼼꼼' }] };
const needsFix = { all: [{ field: '@2', op: 'equals' as const, value: '고칠 점 있음' }] };
const raw = (s: unknown[]) => ({ schemaVersion: 1, fields, output: 'paragraphs', steps: s });
// 초안 → 검토(분류) → 고칠 점 정리(고칠 점이 있으면 초안부터 다시, 2번까지) → 최종
const reviewLoop: AppStep[] = [
  { name: '초안', instruction: '초안을 쓴다' },
  { name: '검토', instruction: '규정에 맞는지 본다', classify: { options: ['통과', '고칠 점 있음'] } },
  { name: '고칠 점 정리', instruction: '검토 결과를 정리', branches: [{ name: '다시 쓰기', when: needsFix, instruction: '고칠 점을 목록으로', back: 1, rounds: 2 }] },
  { name: '최종', instruction: '최종 회신을 쓴다' },
];

describe('정의 검사', () => {
  it('이 단계 또는 앞으로 되돌아가기·횟수(없으면 1)를 받는다', () => {
    const ok = validateAppDefinition(raw(reviewLoop));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value!.steps![2].branches![0]).toMatchObject({ back: 1, rounds: 2 });
    const self = validateAppDefinition(raw([{ name: 'A', instruction: 'a', branches: [{ name: '다듬기', when: careful, instruction: '다시 다듬기', back: 1 }] }, { name: 'B', instruction: 'b' }]));
    expect(self.ok).toBe(true);
    if (self.ok) expect(self.value!.steps![0].branches![0]).toMatchObject({ back: 1, rounds: 1 });
  });
  it('거절 — 마지막 단계·뒤쪽·0·건너가기와 함께·횟수 밖·되돌아가기 없는 횟수', () => {
    const bad = (branch: Record<string, unknown>, at = 0) => {
      const s: Record<string, unknown>[] = [{ name: 'A', instruction: 'a' }, { name: 'B', instruction: 'b' }, { name: 'C', instruction: 'c' }, { name: 'D', instruction: 'd' }];
      s[at] = { ...s[at], branches: [{ name: '갈래', when: careful, instruction: 'x', ...branch }] };
      return validateAppDefinition(raw(s));
    };
    expect(bad({ back: 1 }, 3)).toMatchObject({ ok: false, message: expect.stringContaining('마지막 단계의 갈래는 되돌아갈 수 없습니다') });
    expect(bad({ back: 3 }, 1)).toMatchObject({ ok: false, message: expect.stringContaining('단계 1~2') });
    expect(bad({ back: 0 }, 1)).toMatchObject({ ok: false });
    expect(bad({ back: 1.5 }, 1)).toMatchObject({ ok: false });
    expect(bad({ back: 1, next: 4 }, 1)).toMatchObject({ ok: false, message: expect.stringContaining('함께 둘 수 없습니다') });
    expect(bad({ back: 1, rounds: APP_LOOP_ROUNDS_MAX + 1 }, 1)).toMatchObject({ ok: false, message: expect.stringContaining('1~3번') });
    expect(bad({ back: 1, rounds: 0 }, 1)).toMatchObject({ ok: false });
    expect(bad({ rounds: 2 }, 1)).toMatchObject({ ok: false, message: expect.stringContaining('되돌아갈 단계를 고를 때만') });
  });
  it('판정 함수 — 되돌아갈 자리·횟수', () => {
    expect(branchBackIndex(2, { name: 'x', when: careful, instruction: 'x', back: 1 }, 4)).toBe(0);
    expect(branchBackIndex(2, { name: 'x', when: careful, instruction: 'x', back: 3 }, 4)).toBe(2);
    expect(branchBackIndex(2, { name: 'x', when: careful, instruction: 'x', back: 4 }, 4)).toBeNull();
    expect(branchBackIndex(3, { name: 'x', when: careful, instruction: 'x', back: 1 }, 4)).toBeNull();
    expect(branchBackIndex(1, null, 4)).toBeNull();
    expect(branchRounds({ name: 'x', when: careful, instruction: 'x', back: 1, rounds: 3 })).toBe(3);
    expect(branchRounds({ name: 'x', when: careful, instruction: 'x', back: 1 })).toBe(1);
    expect(APP_LOOPS_PER_RUN).toBe(3);
  });
});

/** 분류 답은 차례대로(다 쓰면 마지막 것) — 그 밖의 단계는 '결과 N' */
function setup(inputs: Record<string, string>, steps: AppStep[], classifyAnswers: string[] = []) {
  const calls: LlmRequest[] = [];
  let n = 0; let c = 0;
  const complete = vi.fn(async (req: LlmRequest) => {
    calls.push(req);
    const text = (req.system ?? '').includes('(분류)') ? classifyAnswers[Math.min(c++, classifyAnswers.length - 1)] : `결과 ${++n}`;
    return { text, usage: { model: 'm', input_tokens: 10, output_tokens: 4 } };
  });
  return {
    calls,
    args: {
      steps, records: steps.map(step => ({ name: step.name, status: 'pending' as const })) as AppStepRecord[], model: 'm', system: '역할',
      messages: [{ role: 'user' as const, content: '원문' }], inputs, usage: { model: 'm', input_tokens: 0, output_tokens: 0 },
      guard: vi.fn(async () => {}), update: vi.fn(), complete,
    },
  };
}

describe('실행', () => {
  it('검토가 고칠 점을 찾으면 초안부터 다시 — 고칠 점 정리 결과를 다시 쓰는 초안에 넘기고, 통과하면 다음으로', async () => {
    const { args, calls } = setup({ kind: '보통', body: 'x' }, reviewLoop, ['고칠 점 있음', '통과']);
    const result = await runAppIntermediateSteps(args as never);
    // 초안·검토·정리(되돌아감) → 초안·검토(통과)·정리(기본 지시)
    expect(args.complete).toHaveBeenCalledTimes(6);
    expect(args.records.map(r => r.status)).toEqual(['completed', 'completed', 'completed', 'running']);
    expect(args.records[1].output).toBe('통과');
    expect(args.records[2]).toMatchObject({ looped: 1 });
    expect(args.records[2].branch).toBeUndefined();
    // 다시 쓰는 초안(넷째 호출)은 되돌아온 까닭(셋째 호출의 결과)을 참고 자료로 받는다
    const redraft = JSON.stringify(calls[3].messages);
    expect(redraft).toContain(APP_LOOP_FEEDBACK_NOTE);
    expect(redraft).toContain('결과 2');
    expect(JSON.stringify(calls[0].messages)).not.toContain(APP_LOOP_FEEDBACK_NOTE);
    // 되돌아오게 한 단계가 다시 끝나면 참고 자료를 거둔다 — 최종 단계에는 없다
    expect(JSON.stringify(result.messages)).not.toContain(APP_LOOP_FEEDBACK_NOTE);
    expect(result.system).toContain('최종 회신을 쓴다');
  });
  it('조건이 그대로면 정한 횟수(2번)까지만 되돌아가고 다음 단계로', async () => {
    const { args } = setup({ kind: '보통', body: 'x' }, reviewLoop, ['고칠 점 있음']);
    await runAppIntermediateSteps(args as never);
    expect(args.complete).toHaveBeenCalledTimes(9);
    expect(args.records[2]).toMatchObject({ status: 'completed', looped: 2, branch: '다시 쓰기' });
    expect(args.records[3].status).toBe('running');
  });
  it('한 실행에 합쳐 3번까지 — 두 단계가 각각 3번씩 되돌아가려 해도', async () => {
    const two: AppStep[] = [
      { name: 'A', instruction: 'a', branches: [{ name: '다듬기', when: careful, instruction: '다시 다듬기', back: 1, rounds: 3 }] },
      { name: 'B', instruction: 'b', branches: [{ name: '다듬기', when: careful, instruction: '다시 다듬기', back: 2, rounds: 3 }] },
      { name: 'C', instruction: 'c' },
    ];
    expect(validateAppDefinition(raw(two)).ok).toBe(true);
    const { args } = setup({ kind: '꼼꼼', body: 'x' }, two);
    await runAppIntermediateSteps(args as never);
    expect(args.complete).toHaveBeenCalledTimes(5); // A 4번 + B 1번
    expect(args.records[0].looped).toBe(3);
    expect(args.records[1].looped).toBeUndefined();
  });
  it('되돌아가는 갈래가 아니면 예전 그대로(한 번씩)', async () => {
    const { args } = setup({ kind: '보통', body: 'x' }, [{ name: 'A', instruction: 'a', branches: [{ name: '다듬기', when: careful, instruction: '다시', back: 1, rounds: 3 }] }, { name: 'B', instruction: 'b' }]);
    await runAppIntermediateSteps(args as never);
    expect(args.complete).toHaveBeenCalledTimes(1);
    expect(args.records[0].looped).toBeUndefined();
  });
});

describe('이어 실행', () => {
  const def: AppDefinition = { schemaVersion: 1, fields, output: 'paragraphs', steps: reviewLoop };
  const input = renderAppInput(def, { kind: '보통', body: 'x' }); if (!input.ok) throw Error('fixture');
  const refs = (s: Array<Record<string, unknown>>) => ({ app_inputs: { kind: '보통', body: 'x' }, app_steps: s.map((x, i) => ({ name: reviewLoop[i].name, ...x })) });
  it('되돌아간 기록도 이어 실행한다(2026-11-25 — 자세한 것은 batch-0306)', () => {
    const looped = refs([{ status: 'completed', output: '초안' }, { status: 'completed', output: '통과', kind: 'classify' }, { status: 'failed', looped: 1 }, { status: 'not_run' }]);
    expect(restoreAppSteps(def, looped, input.message)).toMatchObject({ ok: true, records: [{ reused: true }, { reused: true }, { status: 'pending', looped: 1 }, { status: 'pending' }] });
    expect(hasResumableProgress(looped)).toBe(true);
    const plain = refs([{ status: 'completed', output: '초안' }, { status: 'completed', output: '통과', kind: 'classify' }, { status: 'failed' }, { status: 'not_run' }]);
    expect(restoreAppSteps(def, plain, input.message).ok).toBe(true);
    expect(hasResumableProgress(plain)).toBe(true);
  });
});

describe('예상 AI 호출 수', () => {
  it('입력만으로 정해지는 되돌아가기는 정한 횟수만큼 반드시, 분류에 갈리면 많으면에만', () => {
    const self: AppDefinition = { schemaVersion: 1, fields, output: 'paragraphs', steps: [{ name: 'A', instruction: 'a', branches: [{ name: '다듬기', when: careful, instruction: '다시', back: 1, rounds: 2 }] }, { name: 'B', instruction: 'b' }] };
    expect(estimateAppCalls(self, { kind: '꼼꼼', body: 'x' }, 0)).toMatchObject({ min: 4, max: 4 });
    expect(estimateAppCalls(self, { kind: '보통', body: 'x' }, 0)).toMatchObject({ min: 2, max: 4 });
    const review: AppDefinition = { schemaVersion: 1, fields, output: 'paragraphs', steps: reviewLoop };
    // 한 차례 4번(초안·검토·정리·최종) + 되돌아가면 초안~정리 3번씩 최대 2번
    expect(estimateAppCalls(review, { kind: '보통', body: 'x' }, 0)).toMatchObject({ min: 4, max: 10 });
  });
});

describe('화면', () => {
  const def: AppDefinition = { schemaVersion: 1, fields, output: 'paragraphs', steps: reviewLoop };
  it('빌더 — 가운데 단계의 갈래에 되돌아가기(이 단계 또는 앞)와 횟수, 마지막 단계에는 없음', () => {
    const html = renderToStaticMarkup(createElement(AppStepEditor, { definition: def, onChange: () => {} }));
    expect(html).toContain('단계 1(초안)로 되돌아가기 — 거기서부터 다시');
    expect(html).toContain('단계 3(고칠 점 정리)로 되돌아가기');
    expect(html).not.toContain('단계 4(최종)로 되돌아가기');
    expect(html).toContain('단계 3 갈래 1 되돌아갈 횟수');
    expect(html).toContain('최대 2번');
    expect(html).toContain('한 실행에서 되돌아가기는 합쳐 3번까지');
    const lastBranch = renderToStaticMarkup(createElement(AppStepEditor, { definition: { ...def, steps: [...reviewLoop.slice(0, 3).map(s => ({ ...s, branches: undefined })), { ...reviewLoop[3], branches: [{ name: '갈래', when: careful, instruction: 'x' }] }] }, onChange: () => {} }));
    expect(lastBranch).not.toContain('되돌아가기 — 거기서부터 다시');
    const broken = renderToStaticMarkup(createElement(AppStepEditor, { definition: { ...def, steps: [{ ...reviewLoop[2], branches: [{ ...reviewLoop[2].branches![0], back: 3 }] }, reviewLoop[0], reviewLoop[1], reviewLoop[3]] }, onChange: () => {} }));
    expect(broken).toContain('단계 순서가 바뀌어 되돌아갈 단계가 맞지 않습니다');
  });
  it('결과 — 되돌아가 다시 한 횟수', () => {
    const html = renderToStaticMarkup(createElement(AppStepResults, { steps: [{ name: '정리', status: 'completed', output: 'x', looped: 2 }] }));
    expect(html).toContain('되돌아가 다시 2번');
  });
});
