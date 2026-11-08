import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { APP_MAX_STEPS, branchJumpIndex, renderAppInput, validateAppDefinition, type AppDefinition, type AppStep } from '@/lib/apps/definition';
import { runAppIntermediateSteps, type AppStepRecord } from '@/lib/apps/pipeline';
import { restoreAppSteps } from '@/lib/apps/resume';
import { estimateAppCalls } from '@/lib/apps/call-estimate';
import AppStepEditor from '@/components/apps/AppStepEditor';
import AppStepResults from '@/components/apps/AppStepResults';

/** 갈래의 건너가기(그래프 분기·병합, 2026-11-08) — 갈래로 단계를 마친 뒤 뒤쪽 단계로 건너가고 사이 단계는 건너뛴다. 단계는 5개까지 */

const fields = [
  { key: 'kind', label: '종류', type: 'select' as const, required: true, options: ['단순', '복잡'] },
  { key: 'body', label: '내용', type: 'textarea' as const, required: true },
];
const simple = { all: [{ field: 'kind', op: 'equals' as const, value: '단순' }] };
const steps: AppStep[] = [
  { name: '살펴보기', instruction: '내용을 살핀다', branches: [{ name: '단순 처리', when: simple, instruction: '짧게 정리', next: 4 }] },
  { name: '근거 정리', instruction: '근거를 정리' },
  { name: '쟁점 검토', instruction: '쟁점을 검토' },
  { name: '회신 작성', instruction: '회신을 쓴다' },
];
const def: AppDefinition = { schemaVersion: 1, fields, output: 'paragraphs', steps };
const raw = (s: unknown[]) => ({ schemaVersion: 1, fields, output: 'paragraphs', steps: s });

describe('정의 검사', () => {
  it('갈래의 다음 단계(두 단계 이상 뒤)를 받고, 단계는 5개까지', () => {
    const r = validateAppDefinition(raw(steps));
    expect(r.ok && r.value?.steps?.[0].branches?.[0].next).toBe(4);
    expect(APP_MAX_STEPS).toBe(5);
    const five = Array.from({ length: 5 }, (_, i) => ({ name: `단계${i + 1}`, instruction: 'x' }));
    expect(validateAppDefinition(raw(five)).ok).toBe(true);
    expect(validateAppDefinition(raw([...five, { name: '단계6', instruction: 'x' }]))).toMatchObject({ ok: false, message: '처리 단계는 1~5개로 구성해 주세요.' });
  });
  it('거절: 바로 다음·뒤로·자기·단계 수 밖·정수 아님', () => {
    for (const next of [2, 1, 0, 5, 3.5, '4']) {
      const bad = [{ ...steps[0], branches: [{ ...steps[0].branches![0], next }] }, ...steps.slice(1)];
      const r = validateAppDefinition(raw(bad));
      expect(r.ok, String(next)).toBe(false);
      if (!r.ok) expect(r.message).toContain("갈래 '단순 처리'의 다음 단계");
    }
    // 둘째 단계의 갈래는 단계 4부터
    const second = [steps[0], { ...steps[1], branches: [{ name: 'g', when: simple, instruction: 'x', next: 3 }] }, steps[2], steps[3]];
    expect(validateAppDefinition(raw(second)).ok).toBe(false);
    expect(validateAppDefinition(raw([steps[0], { ...steps[1], branches: [{ name: 'g', when: simple, instruction: 'x', next: 4 }] }, steps[2], steps[3]])).ok).toBe(true);
  });
  it('branchJumpIndex — 앞으로 두 칸 이상·마지막 단계까지만', () => {
    const b = steps[0].branches![0];
    expect(branchJumpIndex(0, b, 4)).toBe(3);
    expect(branchJumpIndex(0, { ...b, next: 2 }, 4)).toBeNull();
    expect(branchJumpIndex(0, { ...b, next: 5 }, 4)).toBeNull();
    expect(branchJumpIndex(0, { ...b, next: undefined }, 4)).toBeNull();
    expect(branchJumpIndex(0, null, 4)).toBeNull();
  });
});

const setup = (inputs: Record<string, string>, records?: AppStepRecord[], s: AppStep[] = steps) => {
  const complete = vi.fn(async () => ({ text: '작업 결과', usage: { model: 'm', input_tokens: 10, output_tokens: 4 } }));
  return {
    steps: s, records: records ?? s.map(step => ({ name: step.name, status: 'pending' as const })), model: 'm', system: '역할',
    messages: [{ role: 'user' as const, content: '원문' }], inputs, usage: { model: 'm', input_tokens: 0, output_tokens: 0 },
    guard: vi.fn(async () => {}), update: vi.fn(), complete,
  };
};

describe('실행', () => {
  it('건너가는 갈래면 사이 단계는 모델을 부르지 않고 건너뜀(갈래 때문), 마지막 단계로', async () => {
    const args = setup({ kind: '단순', body: 'x' });
    const result = await runAppIntermediateSteps(args as never);
    expect(args.complete).toHaveBeenCalledTimes(1);
    expect(args.records).toMatchObject([{ status: 'completed', branch: '단순 처리' }, { status: 'skipped', jumped: true }, { status: 'skipped', jumped: true }, { status: 'running' }]);
    expect(result.system).toContain('회신을 쓴다');
  });
  it('갈래가 아니면 모든 단계를 차례로', async () => {
    const args = setup({ kind: '복잡', body: 'x' });
    await runAppIntermediateSteps(args as never);
    expect(args.complete).toHaveBeenCalledTimes(3);
    expect(args.records.slice(0, 3).every(r => r.status === 'completed' && !r.jumped)).toBe(true);
  });
  it('병합 — 두 갈래가 같은 단계로 건너가고, 중간 단계로 건너가면 그 단계부터 다시 돈다', async () => {
    const merged: AppStep[] = [
      { name: 'A', instruction: 'a', branches: [{ name: '단순', when: simple, instruction: 's', next: 3 }, { name: '복잡', when: { all: [{ field: 'kind', op: 'equals', value: '복잡' }] }, instruction: 'c', next: 3 }] },
      { name: 'B', instruction: 'b' }, { name: 'C', instruction: 'c' }, { name: 'D', instruction: 'd' }, { name: 'E', instruction: 'e' },
    ];
    expect(validateAppDefinition(raw(merged)).ok).toBe(true);
    for (const kind of ['단순', '복잡']) {
      const args = setup({ kind, body: 'x' }, undefined, merged);
      await runAppIntermediateSteps(args as never);
      expect(args.records.map(r => r.status)).toEqual(['completed', 'skipped', 'completed', 'completed', 'running']);
      expect(args.complete).toHaveBeenCalledTimes(3);
    }
  });
  it('이어 실행에서 다시 쓴 단계의 갈래도 건너간다', async () => {
    const records: AppStepRecord[] = [{ name: '살펴보기', status: 'completed', output: '정리', reused: true, branch: '단순 처리' }, { name: '근거 정리', status: 'skipped', jumped: true }, { name: '쟁점 검토', status: 'skipped', jumped: true }, { name: '회신 작성', status: 'pending' }];
    const args = setup({ kind: '단순', body: 'x' }, records);
    await runAppIntermediateSteps(args as never);
    expect(args.complete).not.toHaveBeenCalled();
    expect(args.records.map(r => r.status)).toEqual(['completed', 'skipped', 'skipped', 'running']);
  });
});

describe('재개 검사', () => {
  const longDef: AppDefinition = { ...def, steps: [...steps.slice(0, 3), { name: '보완', instruction: '보완' }, steps[3]] };
  const longSteps = longDef.steps!;
  const input = renderAppInput(longDef, { kind: '단순', body: 'x' }); if (!input.ok) throw Error('fixture');
  const jumpTo5: AppDefinition = { ...longDef, steps: [{ ...longSteps[0], branches: [{ ...longSteps[0].branches![0], next: 4 }] }, ...longSteps.slice(1)] };
  const refs = (s: Array<Record<string, unknown>>) => ({ app_inputs: { kind: '단순', body: 'x' }, app_steps: s.map((x, i) => ({ name: jumpTo5.steps![i].name, ...x })) });
  it('건너간 단계가 기록에서도 건너뛰어져 있으면 받고, 그 뒤 멈춘 단계부터', () => {
    const r = restoreAppSteps(jumpTo5, refs([{ status: 'completed', output: '정리', branch: '단순 처리' }, { status: 'skipped', jumped: true }, { status: 'skipped', jumped: true }, { status: 'failed' }, { status: 'not_run' }]), input.message);
    expect(r).toMatchObject({ ok: true, records: [{ status: 'completed', reused: true }, { status: 'skipped', jumped: true }, { status: 'skipped', jumped: true }, { status: 'pending' }, { status: 'pending' }] });
  });
  it('거절: 건너갔어야 할 단계가 돌았던 기록, 건너가지 않을 단계에 갈래 건너뜀 표시', () => {
    expect(restoreAppSteps(jumpTo5, refs([{ status: 'completed', output: '정리', branch: '단순 처리' }, { status: 'completed', output: '근거' }, { status: 'skipped', jumped: true }, { status: 'failed' }, { status: 'not_run' }]), input.message).ok).toBe(false);
    const noJump = renderAppInput(jumpTo5, { kind: '복잡', body: 'x' }); if (!noJump.ok) throw Error('fixture');
    const r = restoreAppSteps(jumpTo5, { app_inputs: { kind: '복잡', body: 'x' }, app_steps: [{ name: '살펴보기', status: 'completed', output: '정리' }, { name: '근거 정리', status: 'skipped', jumped: true }, { name: '쟁점 검토', status: 'failed' }, { name: '보완', status: 'not_run' }, { name: '회신 작성', status: 'not_run' }] }, noJump.message);
    expect(r.ok).toBe(false);
  });
});

describe('예상 AI 호출 수', () => {
  it('입력만 보고 정해지는 건너가기는 사이 단계를 빼고, 아니면 모두', () => {
    expect(estimateAppCalls(def, { kind: '단순', body: 'x' }, 0)).toMatchObject({ min: 2, max: 2 });
    expect(estimateAppCalls(def, { kind: '복잡', body: 'x' }, 0)).toMatchObject({ min: 4, max: 4 });
  });
  it('분류 결과로 갈리는 건너가기는 사이 단계를 많으면에만', () => {
    const classified: AppDefinition = {
      schemaVersion: 1, fields, output: 'paragraphs', steps: [
        { name: '가르기', instruction: '가른다', classify: { options: ['예', '아니오'] } },
        { name: '판단', instruction: 'x', branches: [{ name: '예', when: { all: [{ field: '@1', op: 'equals', value: '예' }] }, instruction: 'y', next: 5 }] },
        { name: '보충1', instruction: 'x' }, { name: '보충2', instruction: 'x' }, { name: '끝', instruction: 'x' },
      ],
    };
    expect(validateAppDefinition(classified).ok).toBe(true);
    expect(estimateAppCalls(classified, { kind: '단순', body: 'x' }, 0)).toMatchObject({ min: 3, max: 5 });
  });
});

describe('화면', () => {
  it('빌더 — 갈래의 다음 단계 고르기(두 단계 이상 뒤만)·단계 5개·순서가 바뀌면 알림', () => {
    const html = renderToStaticMarkup(createElement(AppStepEditor, { definition: def, onChange: () => {} }));
    expect(html).toContain('단계 1 갈래 1 다음 단계');
    expect(html).toContain('단계 3(쟁점 검토)로 건너가기');
    expect(html).toContain('단계 4(회신 작성)로 건너가기');
    expect(html).not.toContain('단계 2(근거 정리)로 건너가기');
    expect(html).toContain('최대 5단계');
    const broken = renderToStaticMarkup(createElement(AppStepEditor, { definition: { ...def, steps: [{ ...steps[0], branches: [{ ...steps[0].branches![0], next: 2 }] }, ...steps.slice(1)] }, onChange: () => {} }));
    expect(broken).toContain('단계 순서가 바뀌어 건너갈 단계가 맞지 않습니다');
  });
  it('결과 — 갈래 때문에 건너뛴 단계를 가른다', () => {
    const html = renderToStaticMarkup(createElement(AppStepResults, { steps: [{ name: 'a', status: 'skipped', jumped: true }, { name: 'b', status: 'skipped' }] }));
    expect(html).toContain('갈래에 따라 건너뜀');
    expect(html).toContain('조건에 따라 건너뜀');
    expect(readFileSync('src/lib/apps/pipeline.ts', 'utf8')).toContain('args.steps.length > APP_MAX_STEPS');
  });
});
