import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RetrievedChunk } from '@/lib/db';
import { renderAppInput, validateAppDefinition, type AppDefinition, type AppField, type AppStep } from '@/lib/apps/definition';
import { appLookupRunner, runAppIntermediateSteps, stageMessages, type AppStepRecord } from '@/lib/apps/pipeline';
import { APP_DOC_LOOKUP_UNAVAILABLE, appDocLookupTagGap, appDocSearchRunner, filterChunksByTags } from '@/lib/apps/app-doc-lookup';
import { restoreAppSteps } from '@/lib/apps/resume';
import AppStepEditor from '@/components/apps/AppStepEditor';
import AppStepResults from '@/components/apps/AppStepResults';

/** 문서 찾기 단계 태그로 좁히기(2026-11-09) — 찾은 근거 중 그 태그가 붙은 이 기관 문서의 것만 다음 단계로 */

const A = '11111111-2222-4333-8444-555555555551';
const B = '11111111-2222-4333-8444-555555555552';
const C = '99999999-2222-4333-8444-555555555553';
const OWN = 'aaaaaaaa-1111-4111-8111-111111111111';
const fields: AppField[] = [{ key: 'topic', label: '주제', type: 'text', required: true }];
const finalStep: AppStep = { name: '보고서', instruction: '정리하세요.' };
const def = (steps: unknown[]) => validateAppDefinition({ schemaVersion: 1, fields, output: 'bullets', steps });
const tagStep = (tags: unknown, tool = 'doc_search'): unknown => ({ name: '규정 찾기', instruction: '', lookup: { tool, query: '{{topic}}', tags } });
const chunk = (documentId: string, n: number, over: Partial<RetrievedChunk> = {}): RetrievedChunk => ({ documentId, documentTitle: `문서 ${n}`, chunkIndex: n - 1, n, text: `근거 ${n}`, similarity: 0.9, page: n, ...over });

describe('정의', () => {
  it('문서 찾기 단계만·문서 태그와 같은 다듬기·5개까지 — 빈 배열은 없앰', () => {
    const ok = def([tagStep(['#여비 ', ' 복무', '여비']), finalStep]);
    expect(ok.ok && ok.value?.steps?.[0].lookup?.tags).toEqual(['여비', '복무']);
    const empty = def([tagStep([]), finalStep]);
    expect(empty.ok && empty.value?.steps?.[0].lookup).toEqual({ tool: 'doc_search', query: '{{topic}}' });
    expect(def([tagStep(['여비'], 'law_search'), finalStep])).toMatchObject({ ok: false });
    expect(def([tagStep('여비'), finalStep])).toMatchObject({ ok: false }); // 배열만
    expect(def([tagStep(['가'.repeat(21)]), finalStep])).toMatchObject({ ok: false });
    expect(def([tagStep(['a', 'b', 'c', 'd', 'e', 'f']), finalStep])).toMatchObject({ ok: false, message: expect.stringContaining('5개까지') });
  });
});

describe('거르기', () => {
  it('이 기관 문서 중 태그 하나라도 맞는 것만(대소문자 무시) — 공통 기준·태그 모르는 문서는 뺀다, 번호 그대로', () => {
    const tags = new Map([[A, ['여비', 'HR']], [B, ['복무']]]);
    const out = filterChunksByTags([chunk(A, 1), chunk(B, 2), chunk(C, 3, { scope: 'common' }), chunk('x', 4)], tags, ['hr', '복무']);
    expect(out.map((c) => c.n)).toEqual([1, 2]);
    expect(filterChunksByTags([chunk(A, 1)], tags, ['감사'])).toEqual([]);
  });

  it('실행기 — 찾은 뒤 태그를 읽어 거르고, 남는 것이 없으면 정보 공백, 태그를 못 읽으면 멈춘다', async () => {
    const search = vi.fn(async () => [chunk(A, 1), chunk(B, 2), chunk(C, 3, { scope: 'common' })]);
    const loadTags = vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, id === A ? ['여비'] : ['복무']])));
    const runner = appDocSearchRunner({ agentId: OWN, organizationId: 'o1' }, search, [], loadTags);
    const found = await runner('일비', undefined, ['여비']);
    expect(loadTags).toHaveBeenCalledWith([A, B]); // 공통 조각의 문서는 읽지 않는다
    expect(found.content).toContain('[1] 문서 1');
    expect(found.content).not.toContain('문서 2');
    expect(found.gap).toBeUndefined();
    expect(await runner('일비', undefined, ['감사'])).toEqual({ content: appDocLookupTagGap(['감사']), sources: [], gap: true });
    const broken = appDocSearchRunner({ agentId: OWN, organizationId: 'o1' }, search, [], async () => null);
    expect(await broken('일비', undefined, ['여비'])).toEqual({ content: APP_DOC_LOOKUP_UNAVAILABLE, sources: [], isError: true });
    // 태그가 없으면 읽지도 거르지도 않는다(예전 그대로)
    loadTags.mockClear();
    expect((await runner('일비')).content).toContain('문서 2');
    expect(loadTags).not.toHaveBeenCalled();
  });

  it('조회 실행기·파이프라인이 태그를 넘기고 기록·다음 단계 자료에 남긴다 — 태그 없는 단계의 호출 꼴은 그대로', async () => {
    const docs = vi.fn(async () => ({ content: '근거', sources: [] }));
    const lookup = appLookupRunner({ capabilities: { doc_search: {} } }, vi.fn(), docs);
    await lookup('doc_search', 'q', undefined, undefined, ['여비']);
    expect(docs).toHaveBeenLastCalledWith('q', undefined, ['여비']);
    await lookup('doc_search', 'q');
    expect(docs).toHaveBeenLastCalledWith('q', undefined);

    const checked = def([tagStep(['여비']), finalStep]);
    if (!checked.ok || !checked.value) throw new Error('정의');
    const steps = checked.value.steps!;
    const records: AppStepRecord[] = steps.map((s) => ({ name: s.name, status: 'pending' }));
    const run = vi.fn(async () => ({ content: '여비 근거', sources: [] }));
    await runAppIntermediateSteps({
      steps, records, model: 'm', system: 's', inputs: { topic: '일비' }, messages: [{ role: 'user', content: '주제: 일비' }],
      usage: { model: 'm', input_tokens: 0, output_tokens: 0 }, complete: vi.fn() as never, update: () => {}, guard: async () => {}, lookup: run as never,
    });
    expect(run).toHaveBeenCalledWith('doc_search', '일비', undefined, undefined, ['여비']);
    expect(records[0]).toMatchObject({ docSearch: true, tags: ['여비'] });
    expect(String(stageMessages([{ role: 'user', content: 'x' }], records).at(-1)?.content)).toContain('"tags":["여비"]');
  });
});

describe('그 밖', () => {
  it('이어 실행 복원 — 태그 5개·20자', () => {
    const definition: AppDefinition = { schemaVersion: 1, fields, output: 'bullets', steps: [tagStep(['여비']) as AppStep, { name: '정리', instruction: '정리' }, finalStep] };
    const input = renderAppInput(definition, { topic: '일비' }); if (!input.ok) throw Error('fixture');
    const out = restoreAppSteps(definition, {
      app_inputs: { topic: '일비' },
      app_steps: [
        { name: '규정 찾기', status: 'completed', kind: 'lookup', docSearch: true, query: '일비', tags: ['여비', 7, '가'.repeat(30), 'a', 'b', 'c', 'd'], output: '근거' },
        { name: '정리', status: 'failed' },
        { name: '보고서', status: 'not_run' },
      ],
    }, input.message);
    expect(out.ok && out.records[0].tags).toEqual(['여비', '가'.repeat(20), 'a', 'b', 'c']);
  });

  it('결과·편집 화면', () => {
    const html = renderToStaticMarkup(createElement(AppStepResults, { steps: [
      { name: '규정 찾기', status: 'completed', kind: 'lookup', docSearch: true, query: '일비', tags: ['여비', '복무'], output: '근거', sources: [] },
      { name: '보고서', status: 'completed', output: '끝' },
    ] }));
    expect(html).toContain('태그: 여비, 복무');
    const editor = (steps: AppStep[]) => renderToStaticMarkup(createElement(AppStepEditor, { definition: { schemaVersion: 1, fields, output: 'bullets', steps }, onChange: () => {}, lookupTools: ['doc_search', 'law_search'] }));
    const on = editor([tagStep(['여비']) as AppStep, finalStep]);
    expect(on).toContain('단계 1 태그로 좁히기');
    expect(on).toContain('공통 기준 문서는 태그가 없어 빠집니다');
    expect(editor([{ name: '법령', instruction: '', lookup: { tool: 'law_search', query: '{{topic}}' } }, finalStep])).not.toContain('태그로 좁히기');
  });
});
