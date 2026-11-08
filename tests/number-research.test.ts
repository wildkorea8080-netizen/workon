import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  NUMBER_RECHECK_NOTE, RESEARCH_MAX_QUERIES, RESEARCH_QUERY_MAX_CHARS, readRechecked, researchNumbers, researchQueries, sentenceAround,
} from '@/lib/assistant/number-research';
import MessageBubble from '@/components/chat/MessageBubble';

/** 숫자 근거 다시 찾기(2026-11-08) — 확인되지 않은 숫자가 든 문장으로 같은 문서 찾기를 한 번 더 돌려 근거에서 그 숫자를 찾는다 */

const chunk = (text: string, extra: Record<string, unknown> = {}) => ({ documentId: 'd', documentTitle: '여비 규정', chunkIndex: 0, text, similarity: 0.9, ...extra });

describe('숫자가 든 문장', () => {
  it('줄 안에서 문장 끝으로 자르고 인용 번호·마크다운·글머리를 뗀다(소수점은 문장 끝이 아님)', () => {
    const text = '## 결과\n- 국내 여비는 1.5배입니다. **국외 여비**는 12,345원을 줍니다[2]. 끝.';
    const at = text.indexOf('12,345');
    expect(sentenceAround(text, at, at + 6)).toBe('국외 여비는 12,345원을 줍니다.');
    const decimal = text.indexOf('1.5');
    expect(sentenceAround(text, decimal, decimal + 3)).toBe('국내 여비는 1.5배입니다.');
  });
  it('긴 문장은 숫자 앞뒤로 200자', () => {
    const text = `${'가'.repeat(400)} 98,765원 ${'나'.repeat(400)}`;
    const at = text.indexOf('98,765');
    const q = sentenceAround(text, at, at + 6);
    expect(q.length).toBeLessThanOrEqual(RESEARCH_QUERY_MAX_CHARS);
    expect(q).toContain('98,765원');
  });
});

describe('다시 찾을 문장 고르기', () => {
  it('확인되지 않은 숫자의 첫 문장만, 같은 문장은 묶고, 3개까지, 너무 짧은 문장은 빼고', () => {
    const answer = '총액은 11,111원과 22,222원입니다.\n단가는 33,333원입니다.\n44,444\n수량은 55,555개입니다.\n이자는 66,666원입니다.\n다시 11,111원.';
    const q = researchQueries(answer, ['11,111', '22,222', '33,333', '44,444', '55,555', '66,666']);
    expect(q).toEqual([
      { query: '총액은 11,111원과 22,222원입니다.', values: ['11,111', '22,222'] },
      { query: '단가는 33,333원입니다.', values: ['33,333'] },
      { query: '수량은 55,555개입니다.', values: ['55,555'] },
    ]);
    expect(q.length).toBe(RESEARCH_MAX_QUERIES);
  });
});

describe('다시 찾기', () => {
  it('근거 글에 그 숫자가 있으면 확인으로 옮기고 출처(제목·위치)를 남긴다 — 없는 숫자는 그대로', async () => {
    const search = vi.fn(async (q: string) => q.includes('단가') ? [chunk('단가 33,333원', { page: 3 })] : [chunk('관계없는 글 1,000')]);
    const r = await researchNumbers({ answer: '총액은 11,111원입니다.\n단가는 33,333원입니다.', unverified: ['11,111', '33,333'], search });
    expect(r).toEqual({ unverified: ['11,111'], rechecked: [{ value: '33,333', source: '여비 규정 p.3' }], searched: 2, failed: 0, timedOut: false });
  });
  it('공통 자료실 근거는 [공통] 제목(연도)', async () => {
    const r = await researchNumbers({ answer: '단가는 33,333원입니다.', unverified: ['33,333'], search: async () => [chunk('33,333원', { scope: 'common', editionYear: 2026, section: '제3장' })] });
    expect(r.rechecked).toEqual([{ value: '33,333', source: '[공통] 여비 규정(2026) 제3장' }]);
  });
  it('실패·예외는 실패로 세고, 예산을 넘기면 기다리지 않는다', async () => {
    const failed = await researchNumbers({ answer: '단가는 33,333원입니다.', unverified: ['33,333'], search: async () => { throw new Error('x'); } });
    expect(failed).toMatchObject({ unverified: ['33,333'], rechecked: [], failed: 1 });
    const slow = await researchNumbers({ answer: '단가는 33,333원입니다.', unverified: ['33,333'], budgetMs: 10, search: () => new Promise(() => {}) });
    expect(slow).toMatchObject({ unverified: ['33,333'], timedOut: true });
  });
  it('찾을 문장이 없으면 부르지 않는다', async () => {
    const search = vi.fn();
    expect(await researchNumbers({ answer: '44,444', unverified: ['44,444'], search })).toMatchObject({ searched: 0, unverified: ['44,444'] });
    expect(search).not.toHaveBeenCalled();
  });
});

describe('화면', () => {
  it('저장·done 값을 꼴대로 다시 읽는다', () => {
    expect(readRechecked([{ value: '1,000', source: '규정 p.1' }, { value: 3 }, null, 'x'])).toEqual([{ value: '1,000', source: '규정 p.1' }]);
    expect(readRechecked(undefined)).toEqual([]);
  });
  it('확인되지 않은 숫자 안내와 따로, 출처와 함께 보인다', () => {
    const html = renderToStaticMarkup(createElement(MessageBubble, { role: 'assistant', content: '답', numberCheck: ['11,111'], numberRechecked: [{ value: '33,333', source: '여비 규정 p.3' }] }));
    expect(html).toContain('확인되지 않은 숫자: 11,111');
    expect(html).toContain(NUMBER_RECHECK_NOTE([{ value: '33,333', source: '여비 규정 p.3' }]));
    expect(html).toContain('33,333(여비 규정 p.3)');
  });
  it('대화 화면이 done과 지난 대화에서 같은 읽개로 넘긴다', () => {
    const src = readFileSync('src/components/chat/ChatInterface.tsx', 'utf8');
    expect(src).toContain('readRechecked(payload.number_check?.rechecked)');
    expect(src).toContain('readRechecked(m.source_references?.number_check?.rechecked)');
    expect(src).toContain('numberRechecked={msg.numberRechecked}');
  });
});
