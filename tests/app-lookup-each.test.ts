import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { APP_LOOKUP_EACH_MAX, renderAppInput, stepQueryLines, validateAppDefinition, type AppDefinition, type AppField, type AppStep } from '@/lib/apps/definition';
import { APP_DOC_LOOKUP_NOTE, runAppIntermediateSteps, stageMessages, type AppStepRecord } from '@/lib/apps/pipeline';
import { restoreAppSteps } from '@/lib/apps/resume';
import AppStepEditor from '@/components/apps/AppStepEditor';
import AppStepResults from '@/components/apps/AppStepResults';

/** 조사 계획(2026-11-09) — 조회 단계의 `each`: 앞 AI 단계가 쓴 조회어 줄마다(최대 5줄) 한 번씩 찾는다 */

const fields: AppField[] = [{ key: 'topic', label: '주제', type: 'text', required: true }];
const plan: AppStep = { name: '조사 계획', instruction: '찾을 조회어를 한 줄에 하나씩 5개까지 쓰세요.' };
const each = (query = '{{topic}} {{@1}}', extra: Record<string, unknown> = {}): AppStep => ({ name: '줄마다 찾기', instruction: '', lookup: { tool: 'doc_search', query, each: 1, ...extra } as AppStep['lookup'] });
const finalStep: AppStep = { name: '보고서', instruction: '정리하세요.' };
const def = (steps: unknown[]) => validateAppDefinition({ schemaVersion: 1, fields, output: 'bullets', steps });

function run(steps: AppStep[], answer: string, lookup: (tool: string, q: string) => Promise<{ content: string; sources: Array<{ title: string; url: string }>; gap?: boolean; isError?: boolean }>) {
  const records: AppStepRecord[] = steps.map((s) => ({ name: s.name, status: 'pending' }));
  const lookupFn = vi.fn(lookup);
  const done = runAppIntermediateSteps({
    steps, records, model: 'm', system: 's', inputs: { topic: '여비' }, messages: [{ role: 'user', content: '주제: 여비' }],
    usage: { model: 'm', input_tokens: 0, output_tokens: 0 },
    complete: vi.fn(async () => ({ text: answer, usage: { model: 'm', input_tokens: 1, output_tokens: 1 } })),
    update: () => {}, guard: async () => {}, lookup: lookupFn as never,
  });
  return { records, lookupFn, done };
}

const DOC = (n: number) => `/api/documents/1111111${n}-2222-4333-8444-555555555555/original`;

describe('줄 고르기', () => {
  it('줄마다 다듬고 빈 줄·같은 줄은 빼고 최대 5줄', () => {
    expect(stepQueryLines('1. 숙박비 상한\n\n- 일비\n* 숙박비 상한\n2) 교통비\n식비\n출장 신청\n국외 여비')).toEqual(['숙박비 상한', '일비', '교통비', '식비', '출장 신청']);
    expect(APP_LOOKUP_EACH_MAX).toBe(5);
    expect(stepQueryLines('')).toEqual([]);
  });
});

describe('정의 검사', () => {
  it('조회어에 넣은 앞 AI 단계 하나만, 조문 칸과 함께 쓰지 않음', () => {
    expect(def([plan, each(), finalStep])).toMatchObject({ ok: true, value: { steps: [plan, { lookup: { tool: 'doc_search', query: '{{topic}} {{@1}}', each: 1 } }, finalStep] } });
    expect(def([plan, each('{{topic}}'), finalStep])).toMatchObject({ ok: false, message: expect.stringContaining('줄마다 찾기') });
    expect(def([plan, { ...each(), lookup: { tool: 'doc_search', query: '{{@1}}', each: 2 } }, finalStep]).ok).toBe(false);
    expect(def([plan, { ...each(), lookup: { tool: 'doc_search', query: '{{@1}}', each: '1' } }, finalStep]).ok).toBe(false);
    expect(def([plan, { name: '본문', instruction: '', lookup: { tool: 'law_article', query: '{{@1}}', each: 1, article: '15' } }, finalStep])).toMatchObject({ ok: false, message: expect.stringContaining('조문') });
  });
});

describe('실행', () => {
  it('줄마다 한 번씩 찾아 [조회 n] 머리로 잇고, 출처는 겹치지 않게 모으고, 근거 없는 조회어를 따로 남긴다', async () => {
    const t = run([plan, each(), finalStep], '숙박비 상한\n일비\n교통비', async (_tool, q) => (q.endsWith('교통비')
      ? { content: '근거 없음', sources: [], gap: true }
      : { content: `근거: ${q}`, sources: [{ title: '여비 규정', url: DOC(1) }] }));
    await t.done;
    expect(t.lookupFn.mock.calls.map((c) => c[1])).toEqual(['여비 숙박비 상한', '여비 일비', '여비 교통비']);
    expect(t.records[1]).toMatchObject({
      kind: 'lookup', docSearch: true, status: 'completed',
      queries: ['여비 숙박비 상한', '여비 일비', '여비 교통비'], query: '여비 숙박비 상한 / 여비 일비 / 여비 교통비',
      gapQueries: ['여비 교통비'], sources: [{ title: '여비 규정', url: DOC(1) }],
    });
    expect(t.records[1].output).toBe('[조회 1] 여비 숙박비 상한\n근거: 여비 숙박비 상한\n\n[조회 2] 여비 일비\n근거: 여비 일비\n\n[조회 3] 여비 교통비\n근거 없음');
    expect(t.records[1]).not.toHaveProperty('gap');
  });
  it('모든 줄이 근거 없음이면 단계 전체가 정보 공백', async () => {
    const t = run([plan, each(), finalStep], '가\n나', async () => ({ content: '근거 없음', sources: [], gap: true }));
    await t.done;
    expect(t.records[1]).toMatchObject({ gap: true, gapQueries: ['여비 가', '여비 나'] });
  });
  it('앞 단계가 줄을 쓰지 않았으면 멈추고, 한 줄이라도 조회가 실패하면 그 조회어와 함께 멈춘다', async () => {
    // 앞 단계가 기호만 쓴 줄(따옴표·글머리·꼬리표)뿐이면 조회어 줄이 없다 — 줄마다 조회는 아무 조회도 만들지 않는다
    let t = run([plan, each(), finalStep], '"\n-\n**조회어:**', async () => ({ content: 'x', sources: [] }));
    await expect(t.done).rejects.toThrow(/조회어가 비어 있습니다/);
    t = run([plan, each(), finalStep], '가\n나', async (_tool, q) => (q.endsWith('나') ? { content: '불러오지 못했습니다', sources: [], isError: true } : { content: '근거', sources: [] }));
    await expect(t.done).rejects.toThrow(/조회어 '여비 나'/);
  });
  it('다음 단계 자료에 근거 없는 조회어(not_found_queries)를 싣고, 안내가 정보 공백으로 밝히게 한다', () => {
    const records: AppStepRecord[] = [
      { name: '조사 계획', status: 'completed', output: '숙박비\n교통비' },
      { name: '줄마다 찾기', status: 'completed', kind: 'lookup', docSearch: true, query: '숙박비 / 교통비', queries: ['숙박비', '교통비'], gapQueries: ['교통비'], output: '...' },
      { name: '보고서', status: 'pending' },
    ];
    const last = stageMessages([{ role: 'user', content: '원래' }], records).at(-1)!.content as string;
    expect(last).toContain('"not_found_queries":["교통비"]');
    expect(APP_DOC_LOOKUP_NOTE).toContain('not_found_queries');
  });
});

describe('이어 실행·화면', () => {
  it('다시 쓰는 조회 기록에 조회어들·근거 없는 조회어가 남는다', () => {
    const definition: AppDefinition = { schemaVersion: 1, fields, output: 'bullets', steps: [plan, each(), { name: '정리', instruction: '정리' }, finalStep] };
    const input = renderAppInput(definition, { topic: '여비' }); if (!input.ok) throw Error('fixture');
    const out = restoreAppSteps(definition, {
      app_inputs: { topic: '여비' },
      app_steps: [
        { name: '조사 계획', status: 'completed', output: '숙박비\n교통비' },
        { name: '줄마다 찾기', status: 'completed', kind: 'lookup', docSearch: true, query: '여비 숙박비 / 여비 교통비', queries: ['여비 숙박비', '여비 교통비', 7], gapQueries: ['여비 교통비'], output: '근거' },
        { name: '정리', status: 'failed' },
        { name: '보고서', status: 'not_run' },
      ],
    }, input.message);
    expect(out.ok && out.records[1]).toMatchObject({ kind: 'lookup', docSearch: true, queries: ['여비 숙박비', '여비 교통비'], gapQueries: ['여비 교통비'], reused: true });
  });
  it('결과 — 줄마다 횟수·근거 없는 조회어 수, 빌더 — 줄마다 찾기 상자(조문 도구에는 없음)', () => {
    const html = renderToStaticMarkup(createElement(AppStepResults, { steps: [
      { name: '줄마다 찾기', status: 'completed', kind: 'lookup', docSearch: true, query: 'a / b / c', queries: ['a', 'b', 'c'], gapQueries: ['c'], output: '근거', sources: [{ title: '여비', url: DOC(1) }] },
      { name: '보고서', status: 'completed', output: '끝' },
    ] }));
    expect(html).toContain('조회어 3개');
    expect(html).toContain('근거 없는 조회어 1개(정보 공백)');
    const editor = (steps: AppStep[]) => renderToStaticMarkup(createElement(AppStepEditor, { definition: { schemaVersion: 1, fields, output: 'bullets', steps }, onChange: () => {}, lookupTools: ['doc_search', 'law_article'] }));
    expect(editor([plan, each(), finalStep])).toContain('1단계 결과의 줄마다 찾기');
    expect(editor([plan, each(), finalStep])).toContain('<strong>줄마다</strong>');
    expect(editor([plan, { name: '본문', instruction: '', lookup: { tool: 'law_article', query: '{{@1}}' } }, finalStep])).not.toContain('줄마다 찾기(');
  });
});
