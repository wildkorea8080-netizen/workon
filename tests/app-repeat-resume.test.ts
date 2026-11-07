import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { renderAppInput, type AppDefinition } from '@/lib/apps/definition';
import { runAppIntermediateSteps, type AppStepRecord } from '@/lib/apps/pipeline';
import { restoreAppSteps } from '@/lib/apps/resume';
import AppStepResults from '@/components/apps/AppStepResults';

/** 반복 단계 줄 단위 이어 실행(2026-11-07) — 도중에 멈춘 줄마다 반복은 끝난 줄을 다시 부르지 않는다 */

const fields = [
  { key: 'items', label: '질의 목록', type: 'textarea' as const, required: true },
  { key: 'kind', label: '종류', type: 'select' as const, required: true, options: ['민원', '질의'] },
];
const def: AppDefinition = {
  schemaVersion: 1, fields, output: 'paragraphs', steps: [
    { name: '질의별 답', instruction: '각 질의에 답하세요', repeat: { field: 'items' } },
    { name: '회신 작성', instruction: '답을 모아 회신' },
  ],
};
const inputs = { items: '주차 문의\n소음 민원\n가로등 고장', kind: '민원' };
const message = (() => { const r = renderAppInput(def, inputs); if (!r.ok) throw Error('fixture'); return r.message; })();
const usage = () => ({ model: 'm', input_tokens: 0, output_tokens: 0 });
const run = (records: AppStepRecord[], answers: string[]) => {
  const complete = vi.fn(async (_r: { system: string }) => ({ text: answers.shift() ?? '', usage: { model: 'm', input_tokens: 10, output_tokens: 3 } }));
  return { args: { steps: def.steps!, records, model: 'm', system: 'S', messages: [{ role: 'user' as const, content: '원문' }], inputs, usage: usage(), guard: vi.fn(async () => {}), update: vi.fn(), complete }, complete };
};

describe('실행 — 끝난 줄을 기록에 남긴다', () => {
  it('3번째 줄에서 멈추면 앞 두 줄의 결과가 기록(partial)에 남는다', async () => {
    const records: AppStepRecord[] = def.steps!.map((s) => ({ name: s.name, status: 'pending' }));
    const { args } = run(records, ['주차 답', '소음 답', '']);
    await expect(runAppIntermediateSteps(args as never)).rejects.toThrow('3번째 항목');
    expect(records[0].partial).toEqual(['주차 답', '소음 답']);
  });

  it('다 끝나면 partial을 지우고, 이어 실행이면 남은 줄만 부른 뒤 머리를 달아 같은 꼴로 잇는다', async () => {
    const records: AppStepRecord[] = [{ name: '질의별 답', status: 'pending', partial: ['주차 답', '소음 답'] }, { name: '회신 작성', status: 'pending' }];
    const { args, complete } = run(records, ['가로등 답']);
    await runAppIntermediateSteps(args as never);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0].system).toContain('이번 항목(3/3): 가로등 고장');
    expect(records[0]).toMatchObject({ status: 'completed', repeated: 3, reusedItems: 2, output: '### 1. 주차 문의\n주차 답\n\n### 2. 소음 민원\n소음 답\n\n### 3. 가로등 고장\n가로등 답' });
    expect(records[0].partial).toBeUndefined();
  });

  it('이어 실행에서 또 멈추면 앞 기록에 새로 끝난 줄을 더한다', async () => {
    const def4 = { ...inputs, items: '하나\n둘\n셋\n넷' };
    const records: AppStepRecord[] = [{ name: '질의별 답', status: 'pending', partial: ['하나 답'] }, { name: '회신 작성', status: 'pending' }];
    const { args, complete } = run(records, ['둘 답', '']);
    await expect(runAppIntermediateSteps({ ...args, inputs: def4 } as never)).rejects.toThrow('3번째 항목');
    expect(complete).toHaveBeenCalledTimes(2);
    expect(records[0].partial).toEqual(['하나 답', '둘 답']);
  });

  it('partial이 줄 수 이상이면(입력이 줄었음) 쓰지 않고 처음부터', async () => {
    const records: AppStepRecord[] = [{ name: '질의별 답', status: 'pending', partial: ['a', 'b', 'c'] }, { name: '회신 작성', status: 'pending' }];
    const { args, complete } = run(records, ['1', '2', '3']);
    await runAppIntermediateSteps(args as never);
    expect(complete).toHaveBeenCalledTimes(3);
    expect(records[0].reusedItems).toBeUndefined();
  });
});

describe('재개 — 끝난 줄을 다시 쓸 때와 아닐 때', () => {
  const refs = (step0: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ app_inputs: inputs, app_steps: [{ name: '질의별 답', ...step0 }, { name: '회신 작성', status: 'not_run' }], ...extra });

  it('반복이 첫 단계여도 끝난 줄이 있으면 이어 실행할 수 있다(전에는 완료 단계가 없어 막힘)', () => {
    const r = restoreAppSteps(def, refs({ status: 'failed', partial: ['주차 답', '소음 답'] }), message);
    expect(r).toEqual({ ok: true, records: [{ name: '질의별 답', status: 'pending', partial: ['주차 답', '소음 답'] }, { name: '회신 작성', status: 'pending' }] });
  });

  it('쓰지 않음: 끝난 줄이 없음·줄 수 이상·빈 글·글자 아닌 값·12,000자 넘음·갈래가 다름', () => {
    for (const step0 of [
      { status: 'failed' },
      { status: 'failed', partial: [] },
      { status: 'failed', partial: ['a', 'b', 'c'] },
      { status: 'failed', partial: ['a', '  '] },
      { status: 'failed', partial: ['a', 3] },
      { status: 'failed', partial: ['가'.repeat(12001)] },
      { status: 'failed', partial: ['a'], branch: '없는 갈래' },
    ]) expect(restoreAppSteps(def, refs(step0), message).ok, JSON.stringify(step0).slice(0, 80)).toBe(false);
  });

  it('앞 단계가 완료면 평소처럼 재개하고, 멈춘 반복 단계의 끝난 줄도 함께 쓴다', () => {
    const def3: AppDefinition = { ...def, steps: [{ name: '정리', instruction: '정리' }, def.steps![0], def.steps![1]] };
    const msg = (() => { const r = renderAppInput(def3, inputs); if (!r.ok) throw Error('fixture'); return r.message; })();
    const r = restoreAppSteps(def3, { app_inputs: inputs, app_steps: [{ name: '정리', status: 'completed', output: '정리 결과' }, { name: '질의별 답', status: 'failed', partial: ['주차 답'] }, { name: '회신 작성', status: 'not_run' }] }, msg);
    expect(r).toMatchObject({ ok: true, records: [{ status: 'completed', reused: true }, { status: 'pending', partial: ['주차 답'] }, { status: 'pending' }] });
  });

  it('파일마다 반복의 기록은 다시 쓰지 않는다', () => {
    const defFiles: AppDefinition = { ...def, attachments: { required: false }, steps: [{ name: '질의별 답', instruction: 'x', repeat: { files: true } }, def.steps![1]] };
    const msg = (() => { const r = renderAppInput(defFiles, inputs); if (!r.ok) throw Error('fixture'); return r.message; })();
    expect(restoreAppSteps(defFiles, refs({ status: 'failed', partial: ['a'] }), msg).ok).toBe(false);
  });

  it('실행 결과 화면 — 멈춘 단계는 끝난 줄 수와 이어 실행 안내, 이어 실행한 단계는 다시 쓴 줄 수', () => {
    expect(renderToStaticMarkup(createElement(AppStepResults, { steps: [{ name: '질의별 답', status: 'failed', partial: ['a', 'b'] }] }))).toContain('2줄까지 끝남 — 이어 실행하면 다음 줄부터');
    expect(renderToStaticMarkup(createElement(AppStepResults, { steps: [{ name: '질의별 답', status: 'completed', output: 'x', repeated: 3, reusedItems: 2 }] }))).toContain('반복 3줄 (앞 2줄은 이전 결과)');
  });
});
