import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { APP_LOOKUP_TOOLS, validateAppDefinition, type AppField, type AppStep } from '@/lib/apps/definition';
import { executeAppLookup } from '@/lib/connectors';
import { lawApiRejection, lawConnector } from '@/lib/connectors/law';
import AppStepEditor from '@/components/apps/AppStepEditor';

/** 2026-11-12 — 앱 조회 단계의 행정규칙·법령해석례 본문, 국가법령정보 거절 응답의 원인 보이기 */

const fields: AppField[] = [{ key: 'q', label: '규칙 이름', type: 'text', required: true }];
const finalStep: AppStep = { name: '작성', instruction: '작성하세요.' };
const def = (lookup: unknown) => validateAppDefinition({ schemaVersion: 1, fields, output: 'bullets', steps: [{ name: '본문', instruction: '', lookup }, finalStep] });

describe('정의', () => {
  it('행정규칙·해석례 본문은 본문 도구 — 조문 번호·더 찾기는 받지 않는다', () => {
    for (const tool of ['admrul_article', 'interpretation_article'] as const) {
      expect(APP_LOOKUP_TOOLS[tool]).toMatchObject({ connector: 'law', appOnly: true, body: true });
      expect(APP_LOOKUP_TOOLS[tool].article).toBeUndefined();
      expect(def({ tool, query: '{{q}}' }).ok).toBe(true);
      expect(def({ tool, query: '{{q}}', article: '3' })).toMatchObject({ ok: false, message: expect.stringContaining('조문 번호는 법령·자치법규') });
      expect(def({ tool, query: '{{q}}', refine: 1 })).toMatchObject({ ok: false, message: expect.stringContaining('더 찾기는 검색 단계에서') });
    }
    // 법령·자치법규 본문은 그대로(조문 번호 받음)
    expect(APP_LOOKUP_TOOLS.law_article).toMatchObject({ body: true, article: true });
    expect(def({ tool: 'law_article', query: '{{q}}', article: '3' }).ok).toBe(true);
  });
  it('빌더 — 본문 도구는 조문 칸이 법령·자치법규에만, 더 찾기·줄마다 찾기는 본문 도구에 없다', () => {
    const render = (tool: string) => renderToStaticMarkup(createElement(AppStepEditor, {
      definition: { schemaVersion: 1, fields, output: 'bullets', steps: [{ name: '본문', instruction: '', lookup: { tool, query: '{{q}}' } } as AppStep, finalStep] },
      lookupTools: Object.keys(APP_LOOKUP_TOOLS) as never, onChange: () => {},
    } as never));
    const admrul = render('admrul_article');
    expect(admrul).not.toContain('조문 번호(선택)');
    expect(admrul).not.toContain('더 찾기');
    expect(admrul).toContain('행정규칙 본문(훈령·예규·고시, 국가법령정보)');
    expect(render('law_article')).toContain('조문 번호(선택)');
  });
});

describe('커넥터(법제처 응답은 가짜)', () => {
  afterEach(() => vi.unstubAllGlobals());
  function stub(searchBody: unknown, detailBody: (id: string) => unknown) {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      const body = url.includes('lawSearch.do') ? searchBody : detailBody(new URL(url).searchParams.get('ID') ?? '');
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    return calls;
  }

  it('행정규칙 — 이름이 같은 결과의 본문(ID로), 조문 번호는 넘기지 않는다', async () => {
    const calls = stub(
      { AdmRulSearch: { totalCnt: 2, admrul: [{ 행정규칙명: '공무원 여비 업무처리기준 해설', 행정규칙일련번호: '7' }, { 행정규칙명: '공무원 여비 업무처리기준', 행정규칙일련번호: '9' }] } },
      (id) => ({ AdmRulService: { 행정규칙기본정보: { 행정규칙명: id === '9' ? '공무원 여비 업무처리기준' : '해설' }, 조문내용: ['제1조(목적) 이 기준은 여비 지급에 관하여 정한다.'] } }),
    );
    const r = await executeAppLookup('admrul_article', { query: '공무원 여비 업무처리기준', article: '3' });
    expect(r.isError).toBeFalsy();
    expect(calls[0]).toContain('target=admrul');
    expect(calls[1]).toContain('ID=9');
    expect(r.content).toContain('[행정규칙 본문 — 검색어 "공무원 여비 업무처리기준" · 이름이 같은 결과]');
    expect(r.content).toContain('제1조(목적) 이 기준은 여비 지급에 관하여 정한다.');
    expect(r.content).toContain('[다른 검색 결과: 공무원 여비 업무처리기준 해설]');
    expect(r.sources[0].url).toContain('admRulSeq=9');
  });
  it('법령해석례 — 첫 결과의 질의요지·회답 이유', async () => {
    const calls = stub(
      { Expc: { totalCnt: 1, expc: [{ 안건명: '지방공무원의 겸직 허가 범위', 법령해석례일련번호: '55' }] } },
      () => ({ ExpcService: { 안건명: '지방공무원의 겸직 허가 범위', 안건번호: '24-0001', 해석일자: '20240105', 해석기관명: '법제처', 질의기관명: '행정안전부', 질의요지: '겸직 허가 범위는?', 이유: '영리 업무는 허가 대상이다.' } }),
    );
    const r = await executeAppLookup('interpretation_article', { query: '지방공무원 겸직' });
    expect(r.isError).toBeFalsy();
    expect(calls[0]).toContain('target=expc');
    expect(calls[1]).toContain('ID=55');
    expect(r.content).toContain('첫 검색 결과(이름이 같은 결과 없음 — 맞는 자료인지 확인)');
    expect(r.content).toContain('[회답 이유]');
    expect(r.content).toContain('영리 업무는 허가 대상이다.');
  });
  it('국가법령정보가 요청을 거절하면 그 까닭을 보인다(예전엔 응답을 해석할 수 없다고만)', async () => {
    stub({ result: '실패', msg: '사용자 정보 검증에 실패하였습니다.' }, () => ({}));
    const r = await executeAppLookup('admrul_article', { query: '아무 규칙' });
    expect(r).toMatchObject({ isError: true, content: expect.stringContaining('국가법령정보가 요청을 거절했습니다: 사용자 정보 검증에 실패하였습니다.') });
    expect(r.content).toContain('기관 OC가 이 서버 주소에 등록됐는지');
    const plain = await executeAppLookup('law_search', { query: '개인정보 보호법' });
    expect(plain.content).toContain('국가법령정보가 요청을 거절했습니다');
    expect(lawApiRejection({ LawSearch: {} })).toBeNull();
    expect(lawApiRejection({ result: 'x' })).toBeNull();
    expect(lawApiRejection(null)).toBeNull();
  });
  it('새 도구도 앱 전용 — 대화 도구 목록은 그대로', () => {
    expect(lawConnector.tools.map((t) => t.name)).toEqual(['law_search', 'law_get_content']);
  });
});
