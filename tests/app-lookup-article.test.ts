import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { lookupArticleNumber, validateAppDefinition, type AppDefinition, type AppField, type AppStep } from '@/lib/apps/definition';
import { appLookupRunner, runAppIntermediateSteps, type AppStepRecord } from '@/lib/apps/pipeline';
import { AppInputError } from '@/lib/apps/long-input';
import { executeAppLookup } from '@/lib/connectors';
import { lawConnector } from '@/lib/connectors/law';
import AppStepEditor, { switchStepKind } from '@/components/apps/AppStepEditor';

/** 앱 전용 '법령·자치법규 본문' 조회(2026-11-04) — 검색해 이름이 같은(없으면 첫) 결과의 본문, 조 번호를 주면 그 조만 */
const fields: AppField[] = [
  { key: 'law', label: '법령', type: 'text', required: true },
  { key: 'no', label: '조문', type: 'text', required: false },
];
const finalStep: AppStep = { name: '작성', instruction: '작성하세요.' };
const def = (lookup: unknown) => validateAppDefinition({ schemaVersion: 1, fields, output: 'bullets', steps: [{ name: '본문', instruction: '', lookup }, finalStep] });

describe('정의', () => {
  it('조문 칸은 본문 도구에만, 고정 값은 조 번호 꼴, {{키}}는 지금 항목만', () => {
    expect(def({ tool: 'law_article', query: '{{law}}', article: '{{no}}' })).toMatchObject({ ok: true, value: { steps: [{ lookup: { tool: 'law_article', query: '{{law}}', article: '{{no}}' } }, {}] } });
    expect(def({ tool: 'ordinance_article', query: '서울특별시 여비 조례', article: '제5조' }).ok).toBe(true);
    // 빈 조문 칸은 저장하지 않는다
    expect((def({ tool: 'law_article', query: '{{law}}', article: '' }) as { value: AppDefinition }).value.steps![0].lookup).toEqual({ tool: 'law_article', query: '{{law}}' });
    for (const bad of [
      { tool: 'law_search', query: '{{law}}', article: '15' },
      { tool: 'law_article', query: '{{law}}', article: '15항' },
      { tool: 'law_article', query: '{{law}}', article: '{{gone}}' },
      { tool: 'law_article', query: '{{law}}', article: 15 },
      { tool: 'law_article', query: '{{law}}', article: '1\n2' },
    ]) expect(def(bad).ok).toBe(false);
  });
  it('조 번호 읽기', () => {
    expect(lookupArticleNumber('')).toBe('');
    expect(lookupArticleNumber('15')).toBe('15');
    expect(lookupArticleNumber('제 15 조')).toBe('15');
    expect(lookupArticleNumber('015조')).toBe('15');
    for (const bad of ['15항', '제15조의2', 'abc', '12345']) expect(lookupArticleNumber(bad)).toBeNull();
  });
});

function setup(steps: AppStep[]) {
  const records: AppStepRecord[] = steps.map(s => ({ name: s.name, status: 'pending' }));
  return { steps, records, model: 'm', system: 's', messages: [{ role: 'user' as const, content: '원문' }], usage: { model: 'm', input_tokens: 0, output_tokens: 0 }, guard: vi.fn(async () => {}), update: vi.fn(), complete: vi.fn() };
}
const step: AppStep = { name: '본문', instruction: '', lookup: { tool: 'law_article', query: '{{law}}', article: '{{no}}' } };

describe('실행', () => {
  it('입력값으로 조 번호를 만들어 넘기고 기록에 남긴다 — 비면 조 번호 없이', async () => {
    const lookup = vi.fn(async () => ({ content: '제15조 …', sources: [] }));
    const a = setup([step, finalStep]);
    await runAppIntermediateSteps({ ...a, inputs: { law: '개인정보 보호법', no: '제15조' }, lookup });
    expect(lookup).toHaveBeenLastCalledWith('law_article', '개인정보 보호법', '15');
    expect(a.records[0]).toMatchObject({ kind: 'lookup', query: '개인정보 보호법', article: '15', status: 'completed' });
    const b = setup([step, finalStep]);
    await runAppIntermediateSteps({ ...b, inputs: { law: '개인정보 보호법', no: '' }, lookup });
    expect(lookup).toHaveBeenLastCalledWith('law_article', '개인정보 보호법', undefined);
    expect(b.records[0]).not.toHaveProperty('article');
  });
  it('입력한 조 번호가 숫자 꼴이 아니면 부르지 않고 멈춘다', async () => {
    const lookup = vi.fn();
    await expect(runAppIntermediateSteps({ ...setup([step, finalStep]), inputs: { law: 'x', no: '15항' }, lookup })).rejects.toBeInstanceOf(AppInputError);
    expect(lookup).not.toHaveBeenCalled();
  });
  it('조회기는 본문 도구에만 조 번호를 싣는다', async () => {
    const run = vi.fn(async () => ({ content: 'ok', sources: [] }));
    const runner = appLookupRunner({ capabilities: { public_data: { connectors: ['law'] } } }, run);
    await runner('law_article', '여비', '5');
    expect(run).toHaveBeenLastCalledWith('law_article', { query: '여비', article: '5' });
    await runner('law_search', '여비', '5');
    expect(run).toHaveBeenLastCalledWith('law_search', { query: '여비' });
  });
});

describe('커넥터(법제처 응답은 가짜)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const search = { LawSearch: { totalCnt: 2, law: [{ 법령명한글: '개인정보 보호법 시행령', 법령일련번호: '111' }, { 법령명한글: '개인정보 보호법', 법령일련번호: '222' }] } };
  const detail = (name: string) => ({ 법령: { 기본정보: { 법령명_한글: name, 시행일자: '20250101' }, 조문: { 조문단위: [
    { 조문번호: '15', 조문여부: '조문', 조문내용: '제15조(개인정보의 수집·이용)', 항: [{ 항내용: '① 개인정보처리자는 동의를 받은 경우 수집할 수 있다.' }] },
    { 조문번호: '16', 조문여부: '조문', 조문내용: '제16조(개인정보의 수집 제한)' },
  ] } } });
  function stubLaw(searchBody: unknown, detailBody: (mst: string) => unknown) {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      const body = url.includes('lawSearch.do') ? searchBody : detailBody(new URL(url).searchParams.get('MST') ?? '');
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    return calls;
  }

  it('이름이 같은 결과를 골라 그 조만 읽고, 고른 까닭과 다른 결과를 적는다', async () => {
    const calls = stubLaw(search, mst => detail(mst === '222' ? '개인정보 보호법' : '개인정보 보호법 시행령'));
    const result = await executeAppLookup('law_article', { query: '개인정보 보호법', article: '15' });
    expect(result.isError).toBeFalsy();
    expect(calls[1]).toContain('MST=222');
    expect(result.content).toContain('이름이 같은 결과');
    expect(result.content).toContain('① 개인정보처리자는');
    expect(result.content).not.toContain('제16조');
    expect(result.content).toContain('[다른 검색 결과: 개인정보 보호법 시행령]');
    expect(result.sources[0]).toMatchObject({ title: '개인정보 보호법', url: expect.stringContaining('lsiSeq=222') });
  });
  it('이름이 같은 결과가 없으면 첫 결과를 읽고 확인하라고 적는다', async () => {
    const calls = stubLaw(search, () => detail('개인정보 보호법 시행령'));
    const result = await executeAppLookup('law_article', { query: '개인정보' });
    expect(calls[1]).toContain('MST=111');
    expect(result.content).toContain('첫 검색 결과(이름이 같은 결과 없음 — 맞는 자료인지 확인)');
  });
  it('결과가 없거나 없는 조면 실패로', async () => {
    stubLaw({ LawSearch: { totalCnt: 0 } }, () => ({}));
    expect((await executeAppLookup('law_article', { query: '없는 법' })).isError).toBe(true);
    stubLaw(search, () => detail('개인정보 보호법'));
    const missing = await executeAppLookup('law_article', { query: '개인정보 보호법', article: '99' });
    expect(missing).toMatchObject({ isError: true, content: expect.stringContaining('제99조') });
  });
  it('앱 전용 도구는 대화 도구 목록에 없고, 그 밖의 이름은 평소 도구로 간다', async () => {
    expect(lawConnector.tools.map(t => t.name)).toEqual(['law_search', 'law_get_content']);
    expect((await executeAppLookup('constructor', {})).isError).toBe(true);
    stubLaw(search, () => ({}));
    const plain = await executeAppLookup('law_search', { query: '개인정보 보호법' });
    expect(plain.content).toContain('검색 결과 2건');
  });
});

describe('화면', () => {
  it('본문 도구는 조문 칸을 보이고, 검색 도구로 바꾸면 조문 칸을 뗀다', () => {
    const definition: AppDefinition = { schemaVersion: 1, fields, output: 'bullets', steps: [step, finalStep] };
    const page = renderToStaticMarkup(createElement(AppStepEditor, { definition, onChange: () => {}, lookupTools: ['law_article', 'law_search'] }));
    expect(page).toContain('aria-label="단계 1 조문 번호"');
    expect(page).toContain('조문 번호 = 조문');
    expect(page).toContain('보낼 조회어: {{법령}} · 조문: {{조문}}');
    expect(page).toContain('이름이 같은 결과, 없으면 첫 결과의 본문');
    expect(switchStepKind(step, 'law_search', fields).lookup).toEqual({ tool: 'law_search', query: '{{law}}' });
    expect(switchStepKind(step, 'ordinance_article', fields).lookup).toEqual({ tool: 'ordinance_article', query: '{{law}}', article: '{{no}}' });
  });
});
