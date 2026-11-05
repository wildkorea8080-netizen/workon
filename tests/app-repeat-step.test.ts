import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { APP_REPEAT_MAX, renderAppInput, repeatItems, validateAppDefinition, type AppDefinition } from '@/lib/apps/definition';
import { runAppIntermediateSteps, type AppStepRecord } from '@/lib/apps/pipeline';
import { restoreAppSteps } from '@/lib/apps/resume';
import { AppInputError } from '@/lib/apps/long-input';
import AppStepEditor from '@/components/apps/AppStepEditor';
import AppStepResults from '@/components/apps/AppStepResults';

/** 반복 단계(2026-11-06) — 긴 글 입력의 줄마다 중간 단계를 한 번씩, 결과는 줄 순서대로 */

const fields = [
  { key: 'items', label: '질의 목록', type: 'textarea' as const, required: true },
  { key: 'title', label: '제목', type: 'text' as const, required: false },
];
const def: AppDefinition = {
  schemaVersion: 1, fields, output: 'paragraphs', steps: [
    { name: '질의별 답', instruction: '각 질의에 답하세요', repeat: { field: 'items' } },
    { name: '회신 작성', instruction: '답을 모아 회신' },
  ],
};
const raw = (steps: unknown[]) => ({ schemaVersion: 1, fields, output: 'paragraphs', steps });

describe('정의', () => {
  it('긴 글 항목을 반복하는 AI 중간 단계를 받는다', () => {
    const r = validateAppDefinition(raw(def.steps!));
    expect(r.ok && r.value?.steps?.[0].repeat).toEqual({ field: 'items' });
  });

  it('거절: 짧은 글·없는 항목·조회 단계·분류 단계·마지막 단계', () => {
    for (const steps of [
      [{ name: 'a', instruction: 'x', repeat: { field: 'title' } }, { name: '끝', instruction: '끝' }],
      [{ name: 'a', instruction: 'x', repeat: { field: 'nope' } }, { name: '끝', instruction: '끝' }],
      [{ name: 'a', instruction: 'x', repeat: 'items' }, { name: '끝', instruction: '끝' }],
      [{ name: 'a', instruction: '', lookup: { tool: 'law_search', query: '{{title}}' }, repeat: { field: 'items' } }, { name: '끝', instruction: '끝' }],
      [{ name: 'a', instruction: 'x', classify: { options: ['예', '아니오'] }, repeat: { field: 'items' } }, { name: '끝', instruction: '끝' }],
      [{ name: '앞', instruction: 'x' }, { name: '끝', instruction: '끝', repeat: { field: 'items' } }],
    ]) expect(validateAppDefinition(raw(steps)).ok, JSON.stringify(steps).slice(0, 100)).toBe(false);
  });

  it('줄 나누기 — 앞뒤 공백·빈 줄 빼고, 줄은 300자까지', () => {
    expect(repeatItems(' 주차 문의 \r\n\n  소음 민원\n')).toEqual(['주차 문의', '소음 민원']);
    expect(repeatItems(undefined)).toEqual([]);
    expect(repeatItems('가'.repeat(400))[0]).toHaveLength(300);
  });
});

describe('실행', () => {
  const setup = (items: string, answers: string[] = []) => {
    const records: AppStepRecord[] = def.steps!.map((s) => ({ name: s.name, status: 'pending' }));
    const complete = vi.fn(async (_r: { system: string; maxTokens?: number }) => ({ text: answers.shift() ?? '답', usage: { model: 'm', input_tokens: 10, output_tokens: 3 } }));
    return { steps: def.steps!, records, model: 'm', system: 'S', messages: [{ role: 'user' as const, content: '원문' }], inputs: { items }, usage: { model: 'm', input_tokens: 0, output_tokens: 0 }, guard: vi.fn(async () => {}), update: vi.fn(), complete };
  };

  it('줄마다 한 번씩 부르고(그 줄만 처리하라는 지시), 결과는 줄 순서대로 머리를 달아 이어 붙인다', async () => {
    const args = setup('주차 문의\n소음 민원\n가로등 고장', ['주차 답', '소음 답', '가로등 답']);
    const result = await runAppIntermediateSteps(args as never);
    expect(args.complete).toHaveBeenCalledTimes(3);
    expect(args.complete.mock.calls[1][0].system).toContain('이번 항목(2/3): 소음 민원');
    expect(args.guard).toHaveBeenCalledTimes(4);
    expect(args.records[0]).toMatchObject({ status: 'completed', repeated: 3, output: '### 1. 주차 문의\n주차 답\n\n### 2. 소음 민원\n소음 답\n\n### 3. 가로등 고장\n가로등 답' });
    expect(args.usage.input_tokens).toBe(30);
    expect(JSON.stringify(result.messages)).toContain('가로등 답');
  });

  it('줄이 없거나 너무 많으면 모델을 부르지 않고 직원이 고칠 안내로 멈춘다', async () => {
    const empty = setup('  \n ');
    await expect(runAppIntermediateSteps(empty as never)).rejects.toBeInstanceOf(AppInputError);
    const many = setup(Array.from({ length: APP_REPEAT_MAX + 1 }, (_, i) => `항목 ${i}`).join('\n'));
    await expect(runAppIntermediateSteps(many as never)).rejects.toThrow(`${APP_REPEAT_MAX}줄까지`);
    expect(empty.complete).not.toHaveBeenCalled();
    expect(many.complete).not.toHaveBeenCalled();
  });

  it('중간 줄이 비면 그 자리에서 멈추고 앞 줄까지 쓴 토큰은 남긴다', async () => {
    const args = setup('하나\n둘\n셋', ['첫 답', '']);
    await expect(runAppIntermediateSteps(args as never)).rejects.toThrow('2번째 항목');
    expect(args.complete).toHaveBeenCalledTimes(2);
    expect(args.usage.output_tokens).toBe(6);
    expect(args.records[0].status).toBe('running');
  });
});

describe('재개·화면', () => {
  it('재사용한 반복 결과는 줄 수를 그대로 남긴다', () => {
    const input = renderAppInput(def, { items: '하나\n둘' }); if (!input.ok) throw Error('fixture');
    const r = restoreAppSteps(def, { app_inputs: { items: '하나\n둘' }, app_steps: [{ name: '질의별 답', status: 'completed', output: '### 1. 하나\n답', repeated: 2 }, { name: '회신 작성', status: 'failed' }] }, input.message);
    expect(r).toMatchObject({ ok: true, records: [{ reused: true, repeated: 2 }, { status: 'pending' }] });
  });

  it('편집기 — 반복 칸과 반복할 항목(긴 글만), 긴 글 항목이 없으면 막힘, 실행 결과에 줄 수', () => {
    const html = renderToStaticMarkup(createElement(AppStepEditor, { definition: def, onChange: () => {} }));
    expect(html).toContain('aria-label="단계 1 반복"');
    expect(html).toContain('aria-label="단계 1 반복할 항목"');
    expect(html).toMatch(/<option value="items"[^>]*>질의 목록<\/option>/);
    expect(html).not.toMatch(/반복할 항목"[^]*<option value="title"/);
    const noList = renderToStaticMarkup(createElement(AppStepEditor, { definition: { ...def, fields: [fields[1]], steps: [{ name: 'a', instruction: 'x' }, { name: '끝', instruction: '끝' }] }, onChange: () => {} }));
    expect(noList).toMatch(/aria-label="단계 1 반복" disabled=""/);
    expect(noList).toContain('긴 글 입력 항목이 있어야 함');
    expect(renderToStaticMarkup(createElement(AppStepResults, { steps: [{ name: '질의별 답', status: 'completed', output: 'x', repeated: 3 }] }))).toContain('· 반복 3줄');
  });
});
