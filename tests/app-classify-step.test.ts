import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { classifyAnswer, conditionFields, conditionOpsFor, evaluationInputs, renderAppInput, validateAppDefinition, type AppDefinition, type AppStep } from '@/lib/apps/definition';
import { classifySystem, runAppIntermediateSteps, type AppStepRecord } from '@/lib/apps/pipeline';
import { restoreAppSteps } from '@/lib/apps/resume';
import AppStepEditor from '@/components/apps/AppStepEditor';
import AppStepResults from '@/components/apps/AppStepResults';

/** 분류 단계(2026-11-05) — 앞 단계 AI가 선택지 하나를 고르고, 뒤 단계의 조건·갈래가 그 결과(@N)로 가른다 */

const fields = [{ key: 'body', label: '민원 내용', type: 'textarea' as const, required: true }];
const classifyStep: AppStep = { name: '종류 가르기', instruction: '처리해 달라는 요청이면 민원, 묻는 것이면 질의', classify: { options: ['민원', '질의', '제안'] } };
const raw = (steps: unknown[]) => ({ schemaVersion: 1, fields, output: 'paragraphs', steps });
const def: AppDefinition = {
  schemaVersion: 1, fields, output: 'paragraphs', steps: [
    classifyStep,
    { name: '근거 정리', instruction: '관련 규정을 정리', when: { all: [{ field: '@1', op: 'equals', value: '민원' }] } },
    { name: '회신 작성', instruction: '일반 회신', branches: [{ name: '질의 회신', when: { all: [{ field: '@1', op: 'equals', value: '질의' }] }, instruction: '질의에 답하는 회신' }] },
  ],
};

describe('정의 검사', () => {
  it('분류 단계와 뒤 단계의 @N 조건·갈래를 받는다(선택지는 다듬어 저장)', () => {
    const r = validateAppDefinition(raw([{ ...classifyStep, classify: { options: [' 민원', '질의 ', '제안'] } }, def.steps![1], def.steps![2]]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value?.steps?.[0].classify).toEqual({ options: ['민원', '질의', '제안'] });
      expect(r.value?.steps?.[1].when).toEqual({ all: [{ field: '@1', op: 'equals', value: '민원' }] });
    }
  });

  it('거절: 선택지 수·길이·중복·줄바꿈, 마지막 단계·조회 단계·갈래 둔 분류, 선택지 밖 값, 같음·같지 않음 밖 비교, 자기·뒤 단계를 가리키는 @N', () => {
    const bad: unknown[][] = [
      [{ ...classifyStep, classify: { options: ['하나'] } }, { name: '끝', instruction: '끝' }],
      [{ ...classifyStep, classify: { options: ['1', '2', '3', '4', '5', '6', '7'] } }, { name: '끝', instruction: '끝' }],
      [{ ...classifyStep, classify: { options: ['민원', '민원'] } }, { name: '끝', instruction: '끝' }],
      [{ ...classifyStep, classify: { options: ['민원', 'x'.repeat(31)] } }, { name: '끝', instruction: '끝' }],
      [{ ...classifyStep, classify: { options: ['민원', '질\n의'] } }, { name: '끝', instruction: '끝' }],
      [{ ...classifyStep, classify: 'x' }, { name: '끝', instruction: '끝' }],
      [{ name: '앞', instruction: '앞' }, classifyStep],
      [{ ...classifyStep, lookup: { tool: 'law_search', query: '{{body}}' } }, { name: '끝', instruction: '끝' }],
      [{ ...classifyStep, branches: [{ name: 'g', when: { all: [{ field: 'body', op: 'filled' }] }, instruction: 'x' }] }, { name: '끝', instruction: '끝' }],
      [classifyStep, { name: '끝', instruction: '끝', branches: [{ name: 'g', when: { all: [{ field: '@1', op: 'equals', value: '없는값' }] }, instruction: 'x' }] }],
      [classifyStep, { name: '끝', instruction: '끝', branches: [{ name: 'g', when: { all: [{ field: '@1', op: 'filled' }] }, instruction: 'x' }] }],
      [{ ...classifyStep, when: { all: [{ field: '@1', op: 'equals', value: '민원' }] } }, { name: '끝', instruction: '끝' }],
      [{ name: '앞', instruction: '앞', when: { all: [{ field: '@2', op: 'equals', value: '민원' }] } }, classifyStep, { name: '끝', instruction: '끝' }],
      [{ name: '앞', instruction: '앞' }, { name: '끝', instruction: '끝', branches: [{ name: 'g', when: { all: [{ field: '@1', op: 'equals', value: '민원' }] }, instruction: 'x' }] }],
    ];
    for (const steps of bad) expect(validateAppDefinition(raw(steps)).ok, JSON.stringify(steps).slice(0, 120)).toBe(false);
  });

  it('조건 항목은 앞선 분류 단계만 더하고, 분류 결과의 비교는 같음·같지 않음', () => {
    expect(conditionFields(fields, def.steps, 0).map(f => f.key)).toEqual(['body']);
    const later = conditionFields(fields, def.steps, 2);
    expect(later.map(f => [f.key, f.label])).toEqual([['body', '민원 내용'], ['@1', '1단계 분류 결과(종류 가르기)']]);
    expect(conditionOpsFor(later[1])).toEqual(['equals', 'not_equals']);
    expect(conditionOpsFor(fields[0])).toContain('contains');
  });
});

describe('분류 답 읽기', () => {
  const options = ['민원', '질의', '제안', '민원 이송'];
  it('그대로·따옴표·마침표·설명 속 하나면 그 선택지, 둘 이상·없음이면 null', () => {
    expect(classifyAnswer('민원', options)).toBe('민원');
    expect(classifyAnswer(' "질의". ', options)).toBe('질의');
    expect(classifyAnswer('**제안**', options)).toBe('제안');
    expect(classifyAnswer('분류: 질의', options)).toBe('질의');
    expect(classifyAnswer('민원 이송', options)).toBe('민원 이송');
    expect(classifyAnswer('민원 이송 대상입니다', options)).toBe('민원 이송');
    expect(classifyAnswer('민원 또는 질의', options)).toBeNull();
    expect(classifyAnswer('모르겠습니다', options)).toBeNull();
    expect(classifyAnswer('', options)).toBeNull();
  });

  it('판정 값에는 끝난 분류 단계의 결과만 @N으로 들어간다', () => {
    const records: AppStepRecord[] = [{ name: 'a', status: 'completed', output: '질의', kind: 'classify' }, { name: 'b', status: 'completed', output: '긴 글' }, { name: 'c', status: 'pending' }];
    expect(evaluationInputs({ body: 'x' }, def.steps!, records)).toEqual({ body: 'x', '@1': '질의' });
    expect(evaluationInputs({ body: 'x' }, def.steps!, [{ name: 'a', status: 'failed' } as AppStepRecord, ...records.slice(1)])).toEqual({ body: 'x' });
  });
});

describe('실행', () => {
  const setup = (answers: string[]) => {
    const records: AppStepRecord[] = def.steps!.map(step => ({ name: step.name, status: 'pending' }));
    const complete = vi.fn(async (_request: { system: string; maxTokens?: number }) => ({ text: answers.shift() ?? '작업 결과', usage: { model: 'm', input_tokens: 10, output_tokens: 4 } }));
    return { steps: def.steps!, records, model: 'm', system: '역할', messages: [{ role: 'user' as const, content: '민원 원문' }], inputs: { body: '주차 문의' }, usage: { model: 'm', input_tokens: 0, output_tokens: 0 }, guard: vi.fn(async () => {}), update: vi.fn(), complete };
  };

  it('질의로 분류되면 민원 조건 단계는 건너뛰고 마지막 단계가 질의 갈래로', async () => {
    const args = setup(['질의']);
    const result = await runAppIntermediateSteps(args as never);
    expect(args.complete).toHaveBeenCalledTimes(1);
    expect(args.complete.mock.calls[0][0].maxTokens).toBe(60);
    expect(args.complete.mock.calls[0][0].system).toContain('선택지: 민원 / 질의 / 제안');
    expect(args.records).toMatchObject([{ status: 'completed', output: '질의', kind: 'classify' }, { status: 'skipped' }, { status: 'running', branch: '질의 회신' }]);
    expect(result.system).toContain('질의에 답하는 회신');
    expect(args.usage.input_tokens).toBe(10);
  });

  it('민원으로 분류되면 근거 정리 단계가 돌고 마지막은 기본 지시', async () => {
    const args = setup(['민원입니다.', '규정 정리 결과']);
    const result = await runAppIntermediateSteps(args as never);
    expect(args.complete).toHaveBeenCalledTimes(2);
    expect(args.records[0]).toMatchObject({ output: '민원' });
    expect(args.records[1]).toMatchObject({ status: 'completed', output: '규정 정리 결과' });
    expect(args.records[2].branch).toBeUndefined();
    expect(result.system).toContain('일반 회신');
  });

  it('선택지 밖의 답이면 멈추고 쓴 토큰은 남긴다', async () => {
    const args = setup(['잘 모르겠습니다']);
    await expect(runAppIntermediateSteps(args as never)).rejects.toThrow('분류 결과가 선택지(민원 / 질의 / 제안)에 없습니다');
    expect(args.records[0].status).toBe('running');
    expect(args.usage.output_tokens).toBe(4);
  });

  it('분류 지시는 선택지 글자 그대로 한 줄만 쓰게 한다', () => {
    expect(classifySystem('S', classifyStep)).toBe('S\n\n현재 처리 단계: 종류 가르기 (분류)\n처리해 달라는 요청이면 민원, 묻는 것이면 질의\n위 기준으로 원래 입력을 아래 선택지 중 **하나로만** 분류하세요. 답은 선택지 글자 그대로 한 줄만 쓰고, 이유·설명·다른 글은 쓰지 마세요.\n선택지: 민원 / 질의 / 제안');
  });
});

describe('재개', () => {
  const input = renderAppInput(def, { body: '주차 문의' }); if (!input.ok) throw Error('fixture');
  const refs = (first: Record<string, unknown>, second: Record<string, unknown>) => ({ app_inputs: { body: '주차 문의' }, app_steps: [{ name: '종류 가르기', ...first }, { name: '근거 정리', ...second }, { name: '회신 작성', status: 'not_run' }] });

  it('재사용한 분류 결과로 뒤 단계의 건너뛰기를 맞춰 보고, 실행기는 모델을 다시 부르지 않는다', async () => {
    const restored = restoreAppSteps(def, refs({ status: 'completed', output: '질의', kind: 'classify' }, { status: 'skipped' }), input.message);
    expect(restored).toMatchObject({ ok: false }); // 실패한 단계가 없으면 재개할 것이 없다
    const withFail = restoreAppSteps(def, { ...refs({ status: 'completed', output: '민원', kind: 'classify' }, { status: 'failed' }) }, input.message);
    expect(withFail).toMatchObject({ ok: true, records: [{ status: 'completed', reused: true, output: '민원', kind: 'classify' }, { status: 'pending' }, { status: 'pending' }] });
    if (!withFail.ok) return;
    const complete = vi.fn(async () => ({ text: '규정 정리', usage: { model: 'm', input_tokens: 1, output_tokens: 1 } }));
    await runAppIntermediateSteps({ steps: def.steps!, records: withFail.records, model: 'm', system: 'S', messages: [{ role: 'user', content: input.message }], inputs: { body: '주차 문의' }, usage: { model: 'm', input_tokens: 0, output_tokens: 0 }, guard: async () => {}, update: () => {}, complete });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(withFail.records[1]).toMatchObject({ status: 'completed', output: '규정 정리' });
  });

  it('거절: 선택지에 없는 기록·분류 표시 없는 기록·분류였던 단계가 지금은 보통 단계, 건너뛴 기록이 지금 분류와 안 맞음', () => {
    expect(restoreAppSteps(def, refs({ status: 'completed', output: '항의', kind: 'classify' }, { status: 'failed' }), input.message).ok).toBe(false);
    expect(restoreAppSteps(def, refs({ status: 'completed', output: '민원' }, { status: 'failed' }), input.message).ok).toBe(false);
    const plain: AppDefinition = { ...def, steps: [{ name: '종류 가르기', instruction: 'x' }, { name: '근거 정리', instruction: 'y' }, def.steps![2]] };
    const plainInput = renderAppInput(plain, { body: '주차 문의' }); if (!plainInput.ok) throw Error('fixture');
    expect(restoreAppSteps(plain, refs({ status: 'completed', output: '민원', kind: 'classify' }, { status: 'failed' }), plainInput.message).ok).toBe(false);
    expect(restoreAppSteps(def, refs({ status: 'completed', output: '민원', kind: 'classify' }, { status: 'skipped' }), input.message).ok).toBe(false);
  });
});

describe('화면', () => {
  it('편집기 — 분류 단계 칸·선택지, 뒤 단계 조건 항목에 분류 결과, 분류 단계에는 갈래 없음, 마지막 단계는 분류 불가', () => {
    const html = renderToStaticMarkup(createElement(AppStepEditor, { definition: def, onChange: () => {} }));
    expect(html).toContain('aria-label="단계 1 분류 단계"');
    expect(html).toContain('value="민원,질의,제안"');
    expect(html).toContain('1단계 분류 결과(종류 가르기)');
    expect(html).not.toContain('단계 1 갈래 1 이름');
    expect(html).toMatch(/aria-label="단계 3 분류 단계" disabled=""/);
  });

  it('실행 결과 — 고른 분류를 보인다', () => {
    const html = renderToStaticMarkup(createElement(AppStepResults, { steps: [{ name: '종류 가르기', status: 'completed', output: '질의', kind: 'classify' }] }));
    expect(html).toContain('· 분류: 질의');
  });
});
