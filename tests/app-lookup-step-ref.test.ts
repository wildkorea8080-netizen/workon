import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describeLookupQuery, lookupStepRefs, renderLookupQuery, stepQueryText, validateAppDefinition, type AppDefinition, type AppField, type AppStep } from '@/lib/apps/definition';
import { runAppIntermediateSteps, type AppStepRecord } from '@/lib/apps/pipeline';
import AppStepEditor, { stepRefChoices } from '@/components/apps/AppStepEditor';

/** 보완 조사(2026-11-09) — 조회어의 `{{@N}}` = 앞선 AI 단계 결과의 첫 줄. 앞 단계 AI가 다음 조회어를 정하면 그 글로 한 번 더 찾는다 */

const fields: AppField[] = [{ key: 'topic', label: '주제', type: 'text', required: true }];
const plan: AppStep = { name: '조회어 정하기', instruction: '다음에 찾을 조회어를 첫 줄에 한 줄로 쓰세요.' };
const docs = (query: string, name = '보완 찾기'): AppStep => ({ name, instruction: '', lookup: { tool: 'doc_search', query } });
const finalStep: AppStep = { name: '보고서', instruction: '정리하세요.' };
const def = (steps: unknown[]) => validateAppDefinition({ schemaVersion: 1, fields, output: 'bullets', steps });

describe('조회어 한 줄 다듬기', () => {
  it('첫 줄만, 머리 기호·번호·조회어 꼬리표·따옴표를 떼고 공백 하나로, 200자', () => {
    expect(stepQueryText('\n\n- 조회어: "국외 출장 숙박비 상한"\n이유: 앞 근거에 숙박비가 없음')).toBe('국외 출장 숙박비 상한');
    expect(stepQueryText('1) **검색어:** 여비   지급 기준')).toBe('여비 지급 기준');
    expect(stepQueryText('「공무원 여비 규정」')).toBe('공무원 여비 규정');
    expect(stepQueryText('가'.repeat(300))).toHaveLength(200);
    expect(stepQueryText(undefined)).toBe('');
    expect(stepQueryText('‮숨은​글')).toBe('숨은 글');
  });
  it('조회어를 한 번에 바꾼다 — 넣은 값 속의 {{…}}는 다시 자리로 읽히지 않는다', () => {
    expect(renderLookupQuery('{{topic}} {{@1}}', { topic: '여비' }, { '@1': '숙박비 상한' })).toBe('여비 숙박비 상한');
    expect(renderLookupQuery('{{@1}}', { topic: '여비' }, { '@1': '{{topic}}' })).toBe('{{topic}}');
    expect(renderLookupQuery('{{topic}}', { topic: '{{@1}}' }, { '@1': '비밀' })).toBe('{{@1}}');
    // 앞 단계가 없거나(건너뜀) 비면 빈 자리
    expect(renderLookupQuery('{{@2}} 기준', {}, {})).toBe('기준');
  });
  it('화면 보기와 쓰는 단계 번호', () => {
    expect(describeLookupQuery('{{topic}} {{@1}}', fields)).toBe('{{주제}} {{1단계 결과}}');
    expect(lookupStepRefs('{{@1}} {{topic}} {{@3}}')).toEqual([1, 3]);
  });
});

describe('정의 검사', () => {
  it('앞선 AI 단계(처리·분류)의 결과만 — 뒤 단계·자기 자신·조회 단계·없는 단계는 거절', () => {
    expect(def([plan, docs('{{topic}} {{@1}}'), finalStep]).ok).toBe(true);
    const classify: AppStep = { name: '분류', instruction: '고르세요', classify: { options: ['여비', '복무'] } };
    expect(def([classify, docs('{{@1}} 규정'), finalStep]).ok).toBe(true);
    expect(def([docs('{{@1}}'), plan, finalStep])).toMatchObject({ ok: false, message: expect.stringContaining('앞의 AI 단계') });
    expect(def([plan, docs('{{@2}}'), finalStep])).toMatchObject({ ok: false });
    expect(def([docs('{{topic}}', '첫 찾기'), docs('{{@1}}'), finalStep])).toMatchObject({ ok: false, message: expect.stringContaining('앞의 AI 단계') });
    expect(def([plan, docs('{{@0}}'), finalStep]).ok).toBe(false);
    expect(def([plan, docs('{{@1} }'), finalStep]).ok).toBe(false);
  });
});

describe('실행 — 앞 단계가 정한 조회어로 한 번 더 찾는다', () => {
  it('AI 단계 결과 첫 줄이 조회어가 되고, 기록에 실제 보낸 조회어가 남는다', async () => {
    const steps = [docs('{{topic}}', '첫 찾기'), plan, docs('{{topic}} {{@2}}'), finalStep];
    const records: AppStepRecord[] = steps.map((s) => ({ name: s.name, status: 'pending' }));
    const lookup = vi.fn(async (_tool: string, query: string) => ({ content: `근거: ${query}`, sources: [] }));
    const complete = vi.fn(async () => ({ text: '조회어: 국외 출장 숙박비\n이유: 첫 찾기에 숙박비가 없음', usage: { model: 'm', input_tokens: 1, output_tokens: 1 } }));
    await runAppIntermediateSteps({
      steps, records, model: 'm', system: 's', inputs: { topic: '여비' }, messages: [{ role: 'user', content: '주제: 여비' }],
      usage: { model: 'm', input_tokens: 0, output_tokens: 0 }, complete, update: () => {}, guard: async () => {}, lookup,
    });
    expect(lookup.mock.calls.map((c) => c[1])).toEqual(['여비', '여비 국외 출장 숙박비']);
    expect(records[2]).toMatchObject({ kind: 'lookup', query: '여비 국외 출장 숙박비', status: 'completed' });
  });
  it('앞 단계가 건너뛰어져 조회어가 비면 그 단계에서 멈추고 안내한다', async () => {
    const skipped: AppStep = { ...plan, when: { all: [{ field: 'topic', op: 'equals', value: '없는 값' }] } };
    const steps = [skipped, docs('{{@1}}'), finalStep];
    const records: AppStepRecord[] = steps.map((s) => ({ name: s.name, status: 'pending' }));
    await expect(runAppIntermediateSteps({
      steps, records, model: 'm', system: 's', inputs: { topic: '여비' }, messages: [{ role: 'user', content: 'x' }],
      usage: { model: 'm', input_tokens: 0, output_tokens: 0 }, complete: vi.fn(), update: () => {}, guard: async () => {},
      lookup: vi.fn(async () => ({ content: 'x', sources: [] })),
    })).rejects.toThrow(/조회어가 비어 있습니다.*앞 단계 결과/);
  });
});

describe('화면', () => {
  it('앞선 AI 단계만 고를 수 있다', () => {
    expect(stepRefChoices([plan, docs('{{topic}}'), plan, docs('{{@1}}')], 3)).toEqual([1, 3]);
    expect(stepRefChoices([plan], 0)).toEqual([]);
  });
  it('조회 단계에 "+ N단계 결과" 단추와 첫 줄 안내', () => {
    const definition: AppDefinition = { schemaVersion: 1, fields, output: 'bullets', steps: [plan, docs('{{topic}} {{@1}}'), finalStep] };
    const html = renderToStaticMarkup(createElement(AppStepEditor, { definition, onChange: () => {}, lookupTools: ['doc_search'] }));
    expect(html).toContain('+ 1단계 결과');
    expect(html).toContain('첫 줄</strong>만 조회어로');
    expect(html).toContain('{{주제}} {{1단계 결과}}');
  });
});
