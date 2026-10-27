import { describe, it, expect, afterEach } from 'vitest';
import { setLlmAdapterForTests } from '@/lib/llm';
import type { LlmAdapter, LlmRequest } from '@/lib/llm/types';
import { WorkError } from '@/lib/work/types';
import { llmCurrentizeModel, mockCurrentizeModel, parseRewrites, MAX_REWRITE_SOURCE_CHARS, type RewriteInput, type RawRewrite } from '@/lib/work/workflows/currentize/model';
import { verifyRewrites } from '@/lib/work/workflows/currentize/verify';
import type { CitationPair } from '@/lib/work/workflows/currentize/citations';

const changed: CitationPair = {
  segmentId: 's:cit',
  cited: { name: '지방공기업법', article: '제64조', text: '옛 문장' },
  current: { kind: 'law', title: '지방공기업법', article: '제64조', text: '새 문장', enforced: null },
  status: 'changed',
};
const same: CitationPair = { ...changed, segmentId: 's:same', status: 'same' };

function input(over: Partial<RewriteInput> = {}): RewriteInput {
  return {
    title: '2026 업무계획',
    basisDate: '2026-10-28',
    memo: '',
    segments: [
      { id: 's:1', text: '2025년 사업은 제64조에 따라 추진한다.', path: ['Ⅰ. 개요'] },
      { id: 's:2', text: '예산은 1,000천원이다.', path: [] },
      { id: 's:cit', text: '제64조에 따라 옛 문장을 따른다.', path: [] },
    ],
    sources: [{ id: 'src1', name: '지침.txt', text: '올해 지침 본문' }],
    citations: [changed, same],
    ...over,
  };
}
const rw = (over: Partial<RawRewrite>): RawRewrite => ({ segmentId: 's:1', text: '2025년 사업은 제64조에 따라 새롭게 추진한다.', basis: ['src1'], ...over });
const known = new Set<number>([1000, 2500]);

describe('verifyRewrites', () => {
  it('원자료 id를 근거로 단 고치기는 받아들인다', () => {
    const r = verifyRewrites([rw({})], input(), known);
    expect(r.accepted).toHaveLength(1);
    expect(r.proposed).toHaveLength(0);
  });
  it('basis가 비면 제안으로 내린다', () => {
    const r = verifyRewrites([rw({ basis: [] })], input(), known);
    expect(r.accepted).toHaveLength(0);
    expect(r.proposed).toHaveLength(1);
  });
  it('모르는 basis id는 제안으로 내린다', () => {
    expect(verifyRewrites([rw({ basis: ['nope'] })], input(), known).proposed).toHaveLength(1);
    // 같은 인용이라도 '바뀜'이 아닌 조각은 근거가 아니다
    expect(verifyRewrites([rw({ basis: ['s:same'] })], input(), known).proposed).toHaveLength(1);
  });
  it('바뀐 인용 조각 id는 근거로 받아들인다', () => {
    const r = verifyRewrites([rw({ segmentId: 's:cit', text: '제64조에 따라 새 문장을 따른다.', basis: ['s:cit'] })], input(), known);
    expect(r.accepted).toHaveLength(1);
  });
  it('memo는 메모가 있을 때만 근거다', () => {
    expect(verifyRewrites([rw({ basis: ['memo'] })], input({ memo: '' }), known).proposed).toHaveLength(1);
    expect(verifyRewrites([rw({ basis: ['memo'] })], input({ memo: '   ' }), known).proposed).toHaveLength(1);
    expect(verifyRewrites([rw({ basis: ['memo'] })], input({ memo: '이번에는 신규 사업' }), known).accepted).toHaveLength(1);
  });
  it('모르는 새 숫자가 들면 제안으로 내린다', () => {
    const r = verifyRewrites([rw({ segmentId: 's:2', text: '예산은 9,999천원이다.' })], input(), known);
    expect(r.proposed).toHaveLength(1);
  });
  it('원래 글에 있던 숫자나 알려진 숫자는 그대로 받아들인다', () => {
    const a = verifyRewrites([rw({ segmentId: 's:2', text: '예산은 1,000천원으로 확정한다.' })], input(), new Set());
    expect(a.accepted).toHaveLength(1);
    const b = verifyRewrites([rw({ segmentId: 's:2', text: '예산은 2,500천원이다.' })], input(), known);
    expect(b.accepted).toHaveLength(1);
  });
  it('제N조를 빼거나 바꾸면 제안으로 내린다', () => {
    expect(verifyRewrites([rw({ text: '2025년 사업을 추진한다.' })], input(), known).proposed).toHaveLength(1);
    expect(verifyRewrites([rw({ text: '2025년 사업은 제65조에 따라 추진한다.' })], input(), known).proposed).toHaveLength(1);
  });
  it('4자리 연도를 빼거나 바꾸면 제안으로 내린다', () => {
    expect(verifyRewrites([rw({ text: '사업은 제64조에 따라 추진한다.' })], input(), known).proposed).toHaveLength(1);
    expect(verifyRewrites([rw({ text: '2026년 사업은 제64조에 따라 추진한다.' })], input(), known).proposed).toHaveLength(1);
  });
  it('입력 조각에 없는 id는 제안으로 내린다', () => {
    expect(verifyRewrites([rw({ segmentId: 'zzz' })], input(), known).proposed).toHaveLength(1);
  });
  it('입력 순서를 지킨다', () => {
    const raw = [
      rw({ segmentId: 's:2', text: '예산은 1,000천원이다 (확정).' }),
      rw({ basis: [] }),
      rw({ segmentId: 's:cit', text: '제64조에 따라 새 문장.', basis: ['s:cit'] }),
      rw({ segmentId: 's:2', basis: ['x'], text: '예산은 1,000천원.' }),
    ];
    const r = verifyRewrites(raw, input(), known);
    expect(r.accepted.map((x) => x.segmentId)).toEqual(['s:2', 's:cit']);
    expect(r.proposed.map((x) => x.segmentId)).toEqual(['s:1', 's:2']);
  });
});

describe('mockCurrentizeModel', () => {
  it('아무것도 고치지 않는다', async () => {
    const out = await mockCurrentizeModel.rewrite(input(), { model: 'm' });
    expect(out).toEqual({ rewrites: [], usage: null, mode: 'mock' });
  });
});

describe('parseRewrites', () => {
  const inp = input();
  it('JSON을 못 읽으면 LLM_INVALID_OUTPUT', () => {
    expect(() => parseRewrites('아무 말', inp)).toThrow(WorkError);
    let code = '';
    try {
      parseRewrites('{ 깨짐', inp);
    } catch (e) {
      code = (e as WorkError).code;
    }
    expect(code).toBe('LLM_INVALID_OUTPUT');
  });
  it('모르는 segmentId·빈 글·너무 긴 글·잘못된 basis는 버린다', () => {
    const text = JSON.stringify({
      extra: 1,
      rewrites: [
        { segmentId: 's:1', text: '좋은 글', basis: ['src1'], note: '무시' },
        { segmentId: 'nope', text: '글', basis: ['src1'] },
        { segmentId: 's:2', text: '   ', basis: ['src1'] },
        { segmentId: 's:2', text: 'ㄱ'.repeat(6001), basis: ['src1'] },
        { segmentId: 's:2', text: '글', basis: 'src1' },
        { segmentId: 's:2', text: '글', basis: [1] },
        { segmentId: 's:cit', text: '글', basis: [] },
      ],
    });
    expect(parseRewrites(`앞말 ${text} 뒷말`, inp)).toEqual([
      { segmentId: 's:1', text: '좋은 글', basis: ['src1'] },
      { segmentId: 's:cit', text: '글', basis: [] },
    ]);
  });
});

describe('llmCurrentizeModel', () => {
  afterEach(() => setLlmAdapterForTests(null));
  function fake(text: string | Error) {
    const requests: LlmRequest[] = [];
    const adapter: LlmAdapter = {
      async *stream() {},
      async complete(req) {
        requests.push(req);
        if (text instanceof Error) throw text;
        return { text, usage: { model: req.model, input_tokens: 10, output_tokens: 5 } };
      },
    };
    setLlmAdapterForTests(adapter);
    return requests;
  }

  it('조각·원자료·바뀐 인용을 담아 부르고 결과를 읽는다', async () => {
    const requests = fake('{"rewrites":[{"segmentId":"s:1","text":"새 글","basis":["src1"]}]}');
    const out = await llmCurrentizeModel.rewrite(input({ memo: '메모 내용' }), { model: 'claude-haiku-4-5' });
    expect(out.mode).toBe('llm');
    expect(out.rewrites).toEqual([{ segmentId: 's:1', text: '새 글', basis: ['src1'] }]);
    expect(out.usage).toEqual({ model: 'claude-haiku-4-5', input_tokens: 10, output_tokens: 5 });
    const prompt = requests[0].messages[0].content as string;
    expect(prompt).toContain('[조각 id=s:1 path=Ⅰ. 개요]');
    expect(prompt).toContain('[원자료 시작 id=src1');
    expect(prompt).toContain('[원자료 끝 id=src1]');
    expect(prompt).toContain('[근거 조각 id=s:cit');
    expect(prompt).not.toContain('[근거 조각 id=s:same');
    expect(prompt).toContain('메모 내용');
    expect(requests[0].system).toContain('바꿀 필요가 없는 조각은 내지 마라');
    expect(requests[0].system).toContain('basis 없이 바꾸지 마라');
  });

  it('원자료는 글자 예산까지만 싣는다', async () => {
    const requests = fake('{"rewrites":[]}');
    const big = { id: 'big', name: 'a', text: 'x'.repeat(MAX_REWRITE_SOURCE_CHARS + 500) };
    const after = { id: 'after', name: 'b', text: 'y' };
    await llmCurrentizeModel.rewrite(input({ sources: [big, after] }), { model: 'm' });
    const prompt = requests[0].messages[0].content as string;
    expect(prompt).toContain('x'.repeat(MAX_REWRITE_SOURCE_CHARS));
    expect(prompt).not.toContain('x'.repeat(MAX_REWRITE_SOURCE_CHARS + 1));
    expect(prompt).not.toContain('id=after');
  });

  it('호출이 던지면 LLM_UNAVAILABLE', async () => {
    fake(new Error('끊김'));
    await expect(llmCurrentizeModel.rewrite(input(), { model: 'm' })).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE', status: 503 });
  });
  it('읽을 수 없는 응답은 LLM_INVALID_OUTPUT', async () => {
    fake('JSON 아님');
    await expect(llmCurrentizeModel.rewrite(input(), { model: 'm' })).rejects.toMatchObject({ code: 'LLM_INVALID_OUTPUT', status: 502 });
  });
});
