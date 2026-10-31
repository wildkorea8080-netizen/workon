import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 과금 규약 — 모델이 토큰을 쓴 뒤 응답 검사에서 던져도 쓴 토큰은 사용 기록에 한 번 남는다.
 * 예전에는 complete()가 돌려준 usage를 응답 검사(JSON 형식)가 던지면서 버려, Anthropic에는 청구되고
 * usage_logs·예산 판정에서는 빠졌다. 다시 시도하면 새 호출이라 그 토큰도 새로 한 번 남는다(중복 아님).
 */
const llm = vi.hoisted(() => ({ text: '형식이 깨진 답', fail: false }));
const USAGE = { model: 'claude-sonnet-4-6', input_tokens: 1200, output_tokens: 300 };
vi.mock('@/lib/llm', () => ({
  complete: vi.fn(async () => { if (llm.fail) throw new Error('overloaded'); return { text: llm.text, usage: { ...USAGE } }; }),
}));

import { llmGenerator } from '@/lib/work/generation/compose';
import { llmItemsModel } from '@/lib/work/workflows/items/model';
import { llmQaModel } from '@/lib/work/workflows/qa/model';
import { llmRegulationModel } from '@/lib/work/workflows/regulations/model';
import { llmCurrentizeModel } from '@/lib/work/workflows/currentize/model';
import { intakeSpec } from '@/lib/work/workflows/items/specs';
import { spentUsageOf } from '@/lib/work/generation/spent';
import { callModel } from '@/lib/work/runs/shared';
import { WorkError } from '@/lib/work/types';

const opts = { model: 'claude-sonnet-4-6' } as never;
const calls: Record<string, () => Promise<unknown>> = {
  compose: () => llmGenerator.compose({ workflowName: '보고서', workflowPurpose: '보고', title: '가상', facts: [], fields: [], targetIds: ['f1'], sources: [], organizationName: null }, opts),
  items: () => llmItemsModel.extract({ workflowName: '접수공문', title: '가상', facts: [], sources: [], spec: intakeSpec.spec }, opts),
  qa: () => llmQaModel.answer({ kind: 'civil', title: '가상', questionSources: [], evidenceSources: [], priorSources: [], facts: [], definitions: [] } as never, opts),
  plan: () => llmRegulationModel.plan({ question: '출장비', scope: '', basisDate: '2026-10-31', organizationName: null }, opts),
  review: () => llmRegulationModel.review({ question: '출장비', scope: '', basisDate: '2026-10-31', organizationName: null, evidence: [] }, opts),
  rewrite: () => llmCurrentizeModel.rewrite({ title: '가상', basisDate: '2026-10-31', memo: '', segments: [], sources: [], citations: [] }, opts),
};

beforeEach(() => { llm.text = '형식이 깨진 답'; llm.fail = false; });

describe('모델 응답 검사가 던져도 쓴 토큰을 오류에 싣는다', () => {
  it.each(Object.keys(calls))('%s', async key => {
    const error = await calls[key]().then(() => null, e => e);
    expect(error).toBeInstanceOf(WorkError);
    expect((error as WorkError).code).toBe('LLM_INVALID_OUTPUT');
    expect(spentUsageOf(error)).toEqual(USAGE);
  });
  it('모델 호출 자체가 실패하면(토큰 없음) 싣지 않는다', async () => {
    llm.fail = true;
    const error = await calls.compose().then(() => null, e => e);
    expect((error as WorkError).code).toBe('LLM_UNAVAILABLE');
    expect(spentUsageOf(error)).toBeNull();
  });
  it('모양이 틀린 값은 쓴 토큰으로 보지 않는다', () => {
    expect(spentUsageOf(Object.assign(new Error('x'), { spentUsage: { model: 'm', input_tokens: '1' } }))).toBeNull();
    expect(spentUsageOf('문자열')).toBeNull();
  });
});

describe('callModel — 성공·실패 모두 사용 기록 한 번', () => {
  const rows: Record<string, unknown>[] = [];
  const ctx = { store: { writeUsage: async (u: Record<string, unknown>) => { rows.push(u); } } } as never;
  const run = { id: 'run-1', requested_by: 'user-1', attempt: 2 } as never;
  const task = { id: 'task-1', department_id: 'dept-1', workflow_key: 'intake', agent_id: null } as never;
  beforeEach(() => { rows.length = 0; });

  it('성공하면 한 번', async () => {
    const out = await callModel(ctx, run, task, 'extract', async () => ({ usage: { ...USAGE }, value: 1 }));
    expect(out.value).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'work_generate', resourceId: 'run-1', details: { stage: 'extract', input_tokens: 1200, model: USAGE.model, attempt: 2 } });
    expect((rows[0].details as Record<string, unknown>).failed).toBeUndefined();
  });
  it('응답 검사 실패면 쓴 토큰을 한 번 남기고 원래 오류를 다시 던진다', async () => {
    llm.text = 'not json';
    await expect(callModel(ctx, run, task, 'extract', calls.items as never)).rejects.toMatchObject({ code: 'LLM_INVALID_OUTPUT' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ details: { stage: 'extract', output_tokens: 300, failed: true, error_code: 'LLM_INVALID_OUTPUT' } });
    expect((rows[0].details as Record<string, number>).cost_krw).toBeGreaterThan(0);
  });
  it('모델 호출 자체가 실패하면 남기지 않는다', async () => {
    llm.fail = true;
    await expect(callModel(ctx, run, task, 'extract', calls.items as never)).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' });
    expect(rows).toHaveLength(0);
  });
  it('실패 기록을 쓰다 저장소가 던져도 원래 오류를 돌려준다', async () => {
    const broken = { store: { writeUsage: async () => { throw new Error('db down'); } } } as never;
    await expect(callModel(broken, run, task, 'extract', calls.items as never)).rejects.toMatchObject({ code: 'LLM_INVALID_OUTPUT' });
  });
});
