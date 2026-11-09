import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { APP_LOOKUP_OUTPUT_MAX, APP_LOOKUP_TOOLS, appLookupConnectors, describeLookupQuery, renderLookupQuery, validateAppDefinition, type AppDefinition, type AppField, type AppStep } from '@/lib/apps/definition';
import { APP_LOOKUP_SOURCES_MAX, appLookupRunner, runAppIntermediateSteps, stageMessages, type AppStepRecord } from '@/lib/apps/pipeline';
import { AppInputError } from '@/lib/apps/long-input';
import { lookupCapability } from '@/lib/apps/lookup-capability';
import { splitAgentBody } from '@/lib/agent-patch';
import AppStepEditor, { switchStepKind } from '@/components/apps/AppStepEditor';
import AppStepResults from '@/components/apps/AppStepResults';

/** 앱의 공공 데이터 조회 단계(2026-11-04) — 모델 없이 승인된 검색 도구 하나를 정해 둔 조회어로 부른다 */
const fields: AppField[] = [
  { key: 'law', label: '법령', type: 'text', required: true },
  { key: 'memo', label: '메모', type: 'textarea', required: false },
];
const lookupStep: AppStep = { name: '법령 찾기', instruction: '', lookup: { tool: 'law_search', query: '{{law}} 시행령' } };
const finalStep: AppStep = { name: '작성', instruction: '조회 결과로 검토 의견을 작성하세요.' };
const def = (steps: unknown[]) => validateAppDefinition({ schemaVersion: 1, fields, output: 'bullets', steps });

describe('정의 검사', () => {
  it('조회 단계는 지시 없이도 저장되고, 조회어의 {{키}}는 지금 입력 항목만', () => {
    expect(def([lookupStep, finalStep])).toMatchObject({ ok: true, value: { steps: [{ name: '법령 찾기', instruction: '', lookup: { tool: 'law_search', query: '{{law}} 시행령' } }, finalStep] } });
    expect(def([{ ...lookupStep, lookup: { tool: 'g2b_search_bids', query: '청사 리모델링' } }, finalStep]).ok).toBe(true);
    expect(def([{ ...lookupStep, when: { all: [{ field: 'memo', op: 'filled' }] } }, finalStep]).ok).toBe(true);
    // AI 단계는 지금처럼 지시가 있어야 한다
    expect(def([{ name: '정리', instruction: '' }, finalStep]).ok).toBe(false);
  });
  it.each([
    ['모르는 도구', { tool: 'dart_get_company', query: '{{law}}' }],
    ['빈 조회어', { tool: 'law_search', query: '  ' }],
    ['200자 넘는 조회어', { tool: 'law_search', query: 'ㄱ'.repeat(201) }],
    ['줄바꿈', { tool: 'law_search', query: '{{law}}\n시행령' }],
    ['없는 항목', { tool: 'law_search', query: '{{unknown}}' }],
    ['남은 중괄호', { tool: 'law_search', query: '{{law}} {{' }],
    ['꼴이 틀린 자리', { tool: 'law_search', query: '{{ law }}' }],
    ['조회 설정이 객체가 아님', 'law_search'],
  ])('거절: %s', (_, lookup) => {
    expect(def([{ ...lookupStep, lookup }, finalStep]).ok).toBe(false);
  });
  it('조회 단계에 갈래를 둘 수 없고, 마지막 단계는 AI 처리여야 한다', () => {
    const branches = [{ name: '급함', when: { all: [{ field: 'memo', op: 'filled' }] }, instruction: '서둘러' }];
    expect(def([{ ...lookupStep, branches }, finalStep])).toMatchObject({ ok: false, message: expect.stringContaining('갈래') });
    expect(def([finalStep, lookupStep])).toMatchObject({ ok: false, message: expect.stringContaining('AI 처리') });
  });
  it('표의 인자 이름은 커넥터 정의의 inputSchema와 같다(앱 전용 본문 도구는 대화 도구가 아니라 빼고 본다)', () => {
    for (const [tool, spec] of Object.entries(APP_LOOKUP_TOOLS)) {
      if (spec.appOnly) continue;
      const source = readFileSync(`src/lib/connectors/${spec.connector}.ts`, 'utf8');
      const at = source.indexOf(`name: '${tool}'`);
      expect(at).toBeGreaterThan(-1);
      expect(source.slice(at, at + 1500)).toContain(`${spec.param}: {`);
    }
  });
});

describe('조회어·커넥터', () => {
  it('입력값을 넣고 공백을 하나로, 200자에서 자르며 빈 입력은 빈 자리', () => {
    expect(renderLookupQuery('{{law}} 시행령', { law: ' 개인정보 보호법\n' })).toBe('개인정보 보호법 시행령');
    expect(renderLookupQuery('{{law}}', { law: '' })).toBe('');
    expect(renderLookupQuery('{{law}} {{memo}}', { law: 'ㄱ'.repeat(150), memo: 'ㄴ'.repeat(150) })).toHaveLength(200);
    expect(describeLookupQuery('{{law}} 시행령 {{gone}}', fields)).toBe('{{법령}} 시행령 {{gone}}');
  });
  it('정의가 쓰는 커넥터와 빌더 저장 규칙', () => {
    const value = (def([lookupStep, { ...lookupStep, name: '또 찾기' }, finalStep]) as { value: AppDefinition }).value;
    expect(appLookupConnectors(value)).toEqual(['law']);
    expect(appLookupConnectors(null)).toEqual([]);
    // 새로 쓰는 것은 켜고, 예전 조회 때문에 켰다가 안 쓰게 된 것은 끄고, 조회와 상관없이 켠 것은 둔다
    expect(lookupCapability(['kosis'], [], ['law'])).toEqual(['kosis', 'law']);
    expect(lookupCapability(['law', 'kosis'], ['law'], [])).toEqual(['kosis']);
    expect(lookupCapability(['law'], ['law'], ['law'])).toEqual(['law']);
  });
  it('저장 요청에 정의와 능력이 함께 오면 조회 커넥터가 능력에 켜져 있어야 한다', () => {
    const opts = { currentType: 'chat' as const, knownConnectorIds: ['law', 'kosis', 'g2b', 'dart'], knownModelIds: [] };
    const app_definition = { schemaVersion: 1, fields, output: 'bullets', steps: [lookupStep, finalStep] };
    expect(splitAgentBody({ app_definition, capabilities: {} }, opts).error).toContain('공공 데이터');
    expect(splitAgentBody({ app_definition, capabilities: { public_data: { connectors: ['kosis'] } } }, opts).error).toContain('공공 데이터');
    expect(splitAgentBody({ app_definition, capabilities: { public_data: { connectors: ['law'] } } }, opts).error).toBeUndefined();
  });
});

function setup(steps: AppStep[]) {
  const records: AppStepRecord[] = steps.map(s => ({ name: s.name, status: 'pending' }));
  return {
    steps, records, model: 'model', system: '역할', messages: [{ role: 'user' as const, content: '원문' }],
    usage: { model: 'model', input_tokens: 0, output_tokens: 0 }, guard: vi.fn(async () => {}), update: vi.fn(),
    complete: vi.fn(async () => ({ text: '작업 결과', usage: { model: 'model', input_tokens: 10, output_tokens: 5 } })),
  };
}

describe('실행', () => {
  it('모델 없이 조회하고 결과·조회어·출처(http만, 10개까지)를 기록한 뒤 마지막 단계에 외부 자료로 넘긴다', async () => {
    const args = setup([lookupStep, finalStep]);
    const sources = [{ title: '개인정보 보호법 시행령', url: 'https://www.law.go.kr/1' }, { title: '나쁜 링크', url: 'javascript:alert(1)' }, ...Array.from({ length: 12 }, (_, i) => ({ title: `t${i}`, url: `https://x/${i}` }))];
    const lookup = vi.fn(async () => ({ content: '제1조(목적) 이 영은 …', sources }));
    const result = await runAppIntermediateSteps({ ...args, inputs: { law: '개인정보 보호법' }, lookup });
    expect(lookup).toHaveBeenCalledWith('law_search', '개인정보 보호법 시행령', undefined);
    expect(args.complete).not.toHaveBeenCalled(); expect(args.guard).toHaveBeenCalledTimes(1);
    expect(args.usage.input_tokens).toBe(0);
    expect(args.records[0]).toMatchObject({ status: 'completed', kind: 'lookup', query: '개인정보 보호법 시행령', output: '제1조(목적) 이 영은 …' });
    expect(args.records[0].sources).toHaveLength(APP_LOOKUP_SOURCES_MAX);
    expect(args.records[0].sources!.some(s => s.url.startsWith('javascript'))).toBe(false);
    const handed = JSON.stringify(result.messages);
    expect(handed).toContain('공공 데이터 조회 단계가 가져온 외부 자료');
    expect(handed).not.toContain('새로운 사실의 근거로 취급하지 마세요');
  });
  it('긴 조회 결과는 앞부분만, 모델 단계의 결과와는 따로 알린다', async () => {
    const args = setup([lookupStep, { name: '정리', instruction: '정리하세요.' }, finalStep]);
    await runAppIntermediateSteps({ ...args, inputs: { law: '여비' }, lookup: async () => ({ content: '가'.repeat(APP_LOOKUP_OUTPUT_MAX + 50), sources: [] }) });
    expect(args.records[0].output!.length).toBeLessThan(APP_LOOKUP_OUTPUT_MAX + 40);
    expect(args.records[0].output).toContain('앞부분만');
    const messages = stageMessages([], args.records);
    expect(messages[1].content).toContain('이전 단계에서 작성한 작업 결과');
    expect(messages[1].content).toContain('외부 자료');
  });
  it('조건이 안 맞으면 부르지 않는다', async () => {
    const args = setup([{ ...lookupStep, when: { all: [{ field: 'memo', op: 'filled' }] } }, finalStep]);
    const lookup = vi.fn();
    await runAppIntermediateSteps({ ...args, inputs: { law: '여비', memo: '' }, lookup });
    expect(lookup).not.toHaveBeenCalled(); expect(args.records[0].status).toBe('skipped');
  });
  it('빈 조회어·실패·조회 없음은 직원이 읽을 글로 멈춘다(AppInputError)', async () => {
    const empty = setup([{ ...lookupStep, lookup: { tool: 'law_search', query: '{{memo}}' } }, finalStep]);
    const never = vi.fn();
    await expect(runAppIntermediateSteps({ ...empty, inputs: { law: 'x', memo: '' }, lookup: never })).rejects.toThrow(/조회어가 비어/);
    expect(never).not.toHaveBeenCalled(); expect(empty.records[0].status).toBe('running');
    const failed = setup([lookupStep, finalStep]);
    const error = await runAppIntermediateSteps({ ...failed, inputs: { law: 'x' }, lookup: async () => ({ content: '법제처 응답 지연', sources: [], isError: true }) }).catch(e => e);
    expect(error).toBeInstanceOf(AppInputError); expect(error.message).toContain('법령 검색(국가법령정보)에 실패했습니다 — 법제처 응답 지연');
    await expect(runAppIntermediateSteps({ ...setup([lookupStep, finalStep]), inputs: { law: 'x' } })).rejects.toBeInstanceOf(AppInputError);
  });
});

describe('실행 때 권한(appLookupRunner)', () => {
  it('이번 턴 능력에 켜진 커넥터만 부르고 인자 이름은 표대로', async () => {
    const run = vi.fn(async () => ({ content: '결과', sources: [] }));
    const off = await appLookupRunner({ capabilities: { public_data: { connectors: ['kosis'] } } }, run)('law_search', '여비');
    expect(off.isError).toBe(true); expect(run).not.toHaveBeenCalled();
    expect((await appLookupRunner({ capabilities: {} }, run)('law_search', '여비')).isError).toBe(true);
    await appLookupRunner({ capabilities: { public_data: { connectors: ['g2b', 'law'] } } }, run)('g2b_search_bids', '청사');
    expect(run).toHaveBeenCalledWith('g2b_search_bids', { keyword: '청사' });
  });
  it('채팅 실행기가 조회기를 넘기고 조회 숫자·출처를 답변에 잇는다(원본 확인)', () => {
    const stream = readFileSync('src/lib/assistant/stream.ts', 'utf8');
    expect(stream).toContain('lookup: appLookupRunner(turn.ctx, deps.executeTool ?? executeAppLookup, appDocSearchRunner(turn.ctx,');
    expect(stream).toMatch(/step\.kind === 'lookup' && step\.status === 'completed' && step\.output \? numbersIn\(step\.output\)/);
    expect(stream).toMatch(/links: dedupeLinks\(\[\.\.\.result\.links, \.\.\.appRecords\.flatMap/);
  });
});

describe('화면', () => {
  const definition = (steps: AppStep[]): AppDefinition => ({ schemaVersion: 1, fields, output: 'bullets', steps });
  it('처리 방식을 바꾸면 갈래를 떼거나 기본 지시를 채운다', () => {
    const withBranch: AppStep = { name: '검토', instruction: '검토', branches: [{ name: 'b', when: { all: [{ field: 'memo', op: 'filled' }] }, instruction: 'x' }] };
    expect(switchStepKind(withBranch, 'law_search', fields)).toEqual({ name: '검토', instruction: '검토', lookup: { tool: 'law_search', query: '{{law}}' } });
    expect(switchStepKind(lookupStep, '', fields)).toEqual({ name: '법령 찾기', instruction: '앞 단계의 조회 결과와 원래 입력을 바탕으로 정리하세요.' });
  });
  it('기관이 쓰는 공공 데이터만 고를 수 있고, 조회 단계는 조회어·항목 단추를 보이며 갈래는 숨긴다', () => {
    const page = renderToStaticMarkup(createElement(AppStepEditor, { definition: definition([lookupStep, finalStep]), onChange: () => {}, lookupTools: ['law_search'] }));
    expect(page).toContain('aria-label="단계 1 조회어"');
    expect(page).toContain('+ 법령');
    expect(page).toContain('보낼 조회어: {{법령}} 시행령');
    expect(page).toMatch(/<option value="kosis_search_tables" disabled="">공공 데이터 조회 — 통계표 검색\(국가통계포털\) \(기관에서 쓰지 않음\)<\/option>/);
    // 갈래 칸은 AI 단계(2)에만 — 조회 단계(1)에는 없다
    expect(page.split('갈래 (선택)').length - 1).toBe(1);
    expect(page.indexOf('갈래 (선택)')).toBeGreaterThan(page.indexOf('단계 2 이름'));
    const unavailable = renderToStaticMarkup(createElement(AppStepEditor, { definition: definition([lookupStep, finalStep]), onChange: () => {} }));
    expect(unavailable).toContain('이 기관에서 쓰지 않는 공공 데이터라 실행되지 않습니다');
  });
  it('결과 화면은 조회어와 http 출처만 링크로', () => {
    const page = renderToStaticMarkup(createElement(AppStepResults, { steps: [
      { name: '법령 찾기', status: 'completed', kind: 'lookup', query: '여비 규정', output: '결과', sources: [{ title: '공무원 여비 규정', url: 'https://law.go.kr/a' }, { title: '이상한', url: 'javascript:x' }] },
      { name: '작성', status: 'completed', output: '초안' },
    ] }));
    expect(page).toContain('공공 데이터 조회: 여비 규정');
    expect(page).toContain('href="https://law.go.kr/a"');
    expect(page).not.toContain('javascript:x"');
    expect(page).toContain('조회 결과 보기');
  });
});
