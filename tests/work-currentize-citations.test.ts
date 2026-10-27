import { describe, it, expect } from 'vitest';
import { compareCitations } from '@/lib/work/workflows/currentize/citations';
import type { Finding } from '@/lib/work/workflows/currentize/classify';
import type { RegulationProviders, RegulationScope } from '@/lib/work/workflows/regulations/gather';
import type { RawEvidence } from '@/lib/work/workflows/regulations/evidence';
import { WorkError } from '@/lib/work/types';

const scope: RegulationScope = { organizationId: 'org-1', organizationName: '가나시', departmentId: 'dep-1' };
const BASIS = '2026-10-28';

function lawEvidence(over: Partial<RawEvidence> = {}): RawEvidence {
  return {
    kind: 'law',
    title: '공무원 여비 규정',
    location: '제64조(운임)',
    effectiveDate: '2026-01-01',
    editionYear: null,
    issuer: null,
    text: '제64조(운임) 철도운임은 실비로 지급하되 상한을 두지 아니한다.',
    url: null,
    ...over,
  };
}

function fakes(items: RawEvidence[], counts?: { laws: number }): RegulationProviders {
  return {
    orgDocuments: async () => ({ status: 'ok', items: [] }),
    common: async () => ({ status: 'ok', items: [] }),
    laws: async () => {
      if (counts) counts.laws++;
      return { status: 'ok', items };
    },
  };
}

/** 문단 글에서 「…」 인용을 찾아 Finding으로 만든다(분류기와 같은 꼴) */
function cite(segmentId: string, segmentText: string, name: string, article?: string) {
  const text = `「${name}」${article ? ` ${article}` : ''}`;
  const start = segmentText.indexOf(text);
  if (start < 0) throw new Error('시험 글에 인용이 없음');
  const finding: Finding = { kind: 'citation', start, end: start + text.length, text, detail: { name, ...(article ? { article } : {}) } };
  return { segmentId, segmentText, finding };
}

describe('compareCitations', () => {
  it('같음: 작년 인용 문장이 현재 조문에 그대로 있다', async () => {
    const seg = '여비는 「공무원 여비 규정」 제64조 철도운임은 실비로 지급하되 상한을 두지 아니한다.';
    const [pair] = await compareCitations([cite('s1', seg, '공무원 여비 규정', '제64조')], fakes([lawEvidence()]), scope, BASIS);
    expect(pair.status).toBe('same');
    expect(pair.segmentId).toBe('s1');
    expect(pair.cited.name).toBe('공무원 여비 규정');
    expect(pair.cited.article).toBe('제64조');
    expect(pair.current?.kind).toBe('law');
    expect(pair.current?.article).toBe('제64조');
    expect(pair.current?.enforced).toBe('2026-01-01');
    expect(pair.current?.text).toContain('철도운임은 실비로');
  });

  it('바뀜: 조문은 있지만 작년 인용 문장이 현재 조문에 없다', async () => {
    const seg = '「공무원 여비 규정」 제64조 철도운임의 70%만 지급하되 상한을 둔다.';
    const [pair] = await compareCitations([cite('s1', seg, '공무원 여비 규정', '제64조')], fakes([lawEvidence()]), scope, BASIS);
    expect(pair.status).toBe('changed');
    expect(pair.current?.text).toContain('철도운임은 실비로');
  });

  it('없음: 근거를 못 찾으면 current는 null', async () => {
    const seg = '「공무원 여비 규정」 제64조 에 따라 지급한다.';
    const [pair] = await compareCitations([cite('s1', seg, '공무원 여비 규정', '제64조')], fakes([]), scope, BASIS);
    expect(pair.status).toBe('not_found');
    expect(pair.current).toBeNull();
  });

  it('없음: 시행일이 기준일 뒤인 근거는 쓰지 않는다', async () => {
    const seg = '「공무원 여비 규정」 제64조 철도운임은 실비로 지급하되 상한을 두지 아니한다.';
    const future = lawEvidence({ effectiveDate: '2027-03-01' });
    const [pair] = await compareCitations([cite('s1', seg, '공무원 여비 규정', '제64조')], fakes([future]), scope, BASIS);
    expect(pair.status).toBe('not_found');
    expect(pair.current).toBeNull();
  });

  it('없음: 이름이 맞지 않는 근거, 그 조문이 없는 근거는 쓰지 않는다', async () => {
    const seg = '「공무원 여비 규정」 제64조 철도운임은 실비로 지급하되 상한을 두지 아니한다.';
    const other = lawEvidence({ title: '지방공기업법' });
    const wrongArticle = lawEvidence({ location: '제65조(숙박비)', text: '제65조(숙박비) 숙박비는 정액으로 지급한다.' });
    const [a] = await compareCitations([cite('s1', seg, '공무원 여비 규정', '제64조')], fakes([other]), scope, BASIS);
    const [b] = await compareCitations([cite('s1', seg, '공무원 여비 규정', '제64조')], fakes([wrongArticle]), scope, BASIS);
    expect(a.status).toBe('not_found');
    expect(b.status).toBe('not_found');
  });

  it('제76조는 제76조의2 본문으로 대신하지 않는다', async () => {
    const seg = '「공무원 여비 규정」 제76조 에 따라 지급한다.';
    const sub = lawEvidence({ location: '제76조의2(특례)', text: '제76조의2(특례) 특례를 둔다.' });
    const [pair] = await compareCitations([cite('s1', seg, '공무원 여비 규정', '제76조')], fakes([sub]), scope, BASIS);
    expect(pair.status).toBe('not_found');
  });

  it('조문 번호가 없는 인용은 이름이 맞는 근거가 있으면 같음(존재만 확인)', async () => {
    const seg = '「공무원 여비 규정」 에 따라';
    const [pair] = await compareCitations([cite('s1', seg, '공무원 여비 규정')], fakes([lawEvidence()]), scope, BASIS);
    expect(pair.status).toBe('same');
    expect(pair.current?.article).toBeNull();
  });

  it('같은 이름의 인용 둘은 근거를 한 번만 가져온다', async () => {
    const counts = { laws: 0 };
    const s1 = '「공무원 여비 규정」 제64조 철도운임은 실비로 지급하되 상한을 두지 아니한다.';
    const s2 = '또한 「공무원 여비 규정」 제64조 철도운임을 올려 지급하되 상한을 둔다.';
    const pairs = await compareCitations(
      [cite('s1', s1, '공무원 여비 규정', '제64조'), cite('s2', s2, '공무원 여비 규정', '제64조')],
      fakes([lawEvidence()], counts),
      scope,
      BASIS
    );
    expect(counts.laws).toBe(1);
    expect(pairs.map((p) => [p.segmentId, p.status])).toEqual([
      ['s1', 'same'],
      ['s2', 'changed'],
    ]);
  });

  it('다른 이름은 이름마다 가져오고 입력 순서대로 돌려준다', async () => {
    const counts = { laws: 0 };
    const s1 = '「공무원 여비 규정」 제64조 철도운임은 실비로 지급하되 상한을 두지 아니한다.';
    const s2 = '「지방공기업법」 제1조 에 따라 운영한다.';
    const pairs = await compareCitations(
      [cite('s1', s1, '공무원 여비 규정', '제64조'), cite('s2', s2, '지방공기업법', '제1조')],
      fakes([lawEvidence()], counts),
      scope,
      BASIS
    );
    expect(counts.laws).toBe(2);
    expect(pairs.map((p) => [p.segmentId, p.status])).toEqual([
      ['s1', 'same'],
      ['s2', 'not_found'],
    ]);
  });

  it('제공자가 던지면 그대로 전파한다(실행기가 다시 시도)', async () => {
    const providers: RegulationProviders = {
      ...fakes([]),
      laws: async () => {
        throw new Error('boom');
      },
    };
    const seg = '「공무원 여비 규정」 제64조 에 따라 지급한다.';
    const err = await compareCitations([cite('s1', seg, '공무원 여비 규정', '제64조')], providers, scope, BASIS).catch((e) => e);
    expect(err).toBeInstanceOf(WorkError);
    expect(err).toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  });

  it('쓸 수 없다고 한 제공자는 not_found로 이어 간다', async () => {
    const providers: RegulationProviders = {
      orgDocuments: async () => ({ status: 'unavailable', reason: '키 없음' }),
      common: async () => ({ status: 'unavailable', reason: '키 없음' }),
      laws: async () => ({ status: 'unavailable', reason: '키 없음' }),
    };
    const seg = '「공무원 여비 규정」 제64조 에 따라 지급한다.';
    const [pair] = await compareCitations([cite('s1', seg, '공무원 여비 규정', '제64조')], providers, scope, BASIS);
    expect(pair.status).toBe('not_found');
  });

  it('연결 표현(에 따라)을 떼고 내용 낱말로 맞댄다 — 예산·편성이 조문에 있으면 같음', async () => {
    const seg = '사업비는 「지방공기업법」 제64조에 따라 예산을 편성한다';
    const art = lawEvidence({ title: '지방공기업법', text: '제64조(예산) 지방공기업은 매 회계연도 예산을 편성하여 제출한다.' });
    const [pair] = await compareCitations([cite('s1', seg, '지방공기업법', '제64조')], fakes([art]), scope, BASIS);
    expect(pair.cited.text).toBe('에 따라 예산을 편성한다');
    expect(pair.status).toBe('same');
  });

  it('같은 인용이라도 조문이 결산만 말하면 바뀜', async () => {
    const seg = '사업비는 「지방공기업법」 제64조에 따라 예산을 편성한다';
    const art = lawEvidence({ title: '지방공기업법', text: '제64조(결산) 지방공기업은 매 회계연도 결산을 작성하여 제출한다.' });
    const [pair] = await compareCitations([cite('s1', seg, '지방공기업법', '제64조')], fakes([art]), scope, BASIS);
    expect(pair.status).toBe('changed');
  });

  it('짧은 문장은 낱말 하나만 있어도 같음, 없으면 바뀜', async () => {
    const art = lawEvidence({ title: '지방공기업법', text: '제64조(예산) 지방공기업은 예산을 편성한다.' });
    const present = '「지방공기업법」 제64조에 따라 예산';
    const absent = '「지방공기업법」 제64조에 따라 결산';
    const [a] = await compareCitations([cite('s1', present, '지방공기업법', '제64조')], fakes([art]), scope, BASIS);
    const [b] = await compareCitations([cite('s1', absent, '지방공기업법', '제64조')], fakes([art]), scope, BASIS);
    expect(a.status).toBe('same');
    expect(b.status).toBe('changed');
  });

  it('낱말이 많으면 70% 이상 있을 때 같음', async () => {
    const art = lawEvidence({ title: '지방공기업법', text: '제64조(예산) 예산 편성 심의 의결 공고를 한다.' });
    const ok = '「지방공기업법」 제64조 예산 편성 심의 의결 결산'; // 5개 중 4개
    const bad = '「지방공기업법」 제64조 예산 결산 감사 정산 보고'; // 5개 중 1개
    const [a] = await compareCitations([cite('s1', ok, '지방공기업법', '제64조')], fakes([art]), scope, BASIS);
    const [b] = await compareCitations([cite('s1', bad, '지방공기업법', '제64조')], fakes([art]), scope, BASIS);
    expect(a.status).toBe('same');
    expect(b.status).toBe('changed');
  });

  it('연결 표현만 있거나 문장이 없으면 반박할 내용이 없어 같음(조문이 있을 때)', async () => {
    const empty = '「공무원 여비 규정」 제64조';
    const connectorOnly = '「공무원 여비 규정」 제64조에 따라';
    const [a] = await compareCitations([cite('s1', empty, '공무원 여비 규정', '제64조')], fakes([lawEvidence()]), scope, BASIS);
    const [b] = await compareCitations([cite('s1', connectorOnly, '공무원 여비 규정', '제64조')], fakes([lawEvidence()]), scope, BASIS);
    expect(a.cited.text).toBe('');
    expect(a.status).toBe('same');
    expect(b.status).toBe('same');
  });

  it('조문이 없으면 문장이 비어도 없음', async () => {
    const [pair] = await compareCitations([cite('s1', '「공무원 여비 규정」 제64조', '공무원 여비 규정', '제64조')], fakes([]), scope, BASIS);
    expect(pair.status).toBe('not_found');
  });

  // ── 이름은 같아야만 같은 규정 ──
  it('법을 인용했는데 시행령에만 그 조문이 있으면 없음(이름이 비슷한 다른 규정으로 넘어가지 않는다)', async () => {
    const decree = lawEvidence({ title: '지방공기업법 시행령', text: '제64조(예산) 예산을 편성한다.' });
    const seg = '「지방공기업법」 제64조에 따라 예산을 편성한다';
    const [pair] = await compareCitations([cite('s1', seg, '지방공기업법', '제64조')], fakes([decree]), scope, BASIS);
    expect(pair.status).toBe('not_found');
    expect(pair.current).toBeNull();
  });

  it('시행령을 인용했는데 법에만 그 조문이 있어도 없음', async () => {
    const law = lawEvidence({ title: '지방공기업법', text: '제64조(예산) 예산을 편성한다.' });
    const seg = '「지방공기업법 시행령」 제64조에 따라 예산을 편성한다';
    const [pair] = await compareCitations([cite('s1', seg, '지방공기업법 시행령', '제64조')], fakes([law]), scope, BASIS);
    expect(pair.status).toBe('not_found');
  });

  it('법과 시행령이 다 있으면 이름이 같은 쪽과 맞댄다', async () => {
    const decree = lawEvidence({ title: '지방공기업법 시행령', text: '제64조(결산) 결산을 작성한다.' });
    const law = lawEvidence({ title: '지방공기업법', text: '제64조(예산) 예산을 편성한다.' });
    const seg = '「지방공기업법」 제64조에 따라 예산을 편성한다';
    const [pair] = await compareCitations([cite('s1', seg, '지방공기업법', '제64조')], fakes([decree, law]), scope, BASIS);
    expect(pair.current?.title).toBe('지방공기업법');
    expect(pair.status).toBe('same');
  });

  it('이름의 공백·(약칭) 괄호 차이는 같은 이름', async () => {
    const law = lawEvidence({ title: '지방공기업법 (약칭: 지공법)', text: '제64조(예산) 예산을 편성한다.' });
    const seg = '「지방 공기업법」 제64조에 따라 예산을 편성한다';
    const [pair] = await compareCitations([cite('s1', seg, '지방 공기업법', '제64조')], fakes([law]), scope, BASIS);
    expect(pair.status).toBe('same');
  });

  // ── 숫자는 꼭 맞아야 한다 ──
  it('작년 문장의 수치가 조문에 없으면 다른 낱말이 맞아도 바뀜', async () => {
    const seg = '「공무원 여비 규정」 제64조 철도운임의 70%만 지급하되 상한을 두지 아니한다';
    const [pair] = await compareCitations([cite('s1', seg, '공무원 여비 규정', '제64조')], fakes([lawEvidence()]), scope, BASIS);
    expect(pair.status).toBe('changed');
  });

  it('수치가 조문에 있고 낱말이 70% 이상 맞으면 같음', async () => {
    const art = lawEvidence({ text: '제64조(운임) 철도운임은 70%를 지급하되 상한을 두지 아니한다.' });
    const seg = '「공무원 여비 규정」 제64조 철도운임의 70%만 지급하되 상한을 두지 아니한다';
    const [pair] = await compareCitations([cite('s1', seg, '공무원 여비 규정', '제64조')], fakes([art]), scope, BASIS);
    expect(pair.status).toBe('same');
  });

  // ── 비율 경계 ──
  const W = ['예산', '편성', '검토', '결의', '공고', '보고', '감사', '정산', '결산', '계획'];
  async function ratio(total: number, present: number) {
    const art = lawEvidence({ title: '지방공기업법', text: `제64조(총칙) ${W.slice(0, present).join(' ')}` });
    // 앞 present개가 조문에 있고 나머지는 없다
    const seg = `「지방공기업법」 제64조 ${W.slice(0, total).join(' ')}`;
    const [pair] = await compareCitations([cite('s1', seg, '지방공기업법', '제64조')], fakes([art]), scope, BASIS);
    return pair.status;
  }
  it('낱말 3개 중 2개가 있으면 바뀜', async () => {
    expect(await ratio(3, 2)).toBe('changed');
    expect(await ratio(3, 3)).toBe('same');
  });
  it('낱말 4개 중 3개(75%)면 같음', async () => {
    expect(await ratio(4, 3)).toBe('same');
  });
  it('낱말 10개 중 7개면 같고 6개면 바뀜', async () => {
    expect(await ratio(10, 7)).toBe('same');
    expect(await ratio(10, 6)).toBe('changed');
  });

  // ── 조문 고르기 ──
  it('제76조의2를 인용하면 제76조의2 조문과 맞댄다', async () => {
    const art = lawEvidence({ text: '제76조의2(특례) 특례를 둔다.' });
    const seg = '「공무원 여비 규정」 제76조의2에 따라 특례';
    const [pair] = await compareCitations([cite('s1', seg, '공무원 여비 규정', '제76조의2')], fakes([art]), scope, BASIS);
    expect(pair.current?.article).toBe('제76조의2');
    expect(pair.status).toBe('same');
  });

  it('한 근거에 조문이 여럿이면 그 조문의 글만 쓴다(제65조의 낱말은 세지 않는다)', async () => {
    const art = lawEvidence({ text: '제64조(운임) 철도운임은 실비로 지급한다.\n제65조(숙박비) 숙박비는 정액으로 지급한다.' });
    const seg = '「공무원 여비 규정」 제64조 숙박비는 정액으로 지급한다';
    const [pair] = await compareCitations([cite('s1', seg, '공무원 여비 규정', '제64조')], fakes([art]), scope, BASIS);
    expect(pair.current?.text).toContain('철도운임');
    expect(pair.current?.text).not.toContain('숙박비');
    expect(pair.status).toBe('changed');
  });

  it('시행일을 모르는 근거도 쓴다(date_unknown)', async () => {
    const art = lawEvidence({ effectiveDate: null });
    const seg = '「공무원 여비 규정」 제64조 철도운임은 실비로 지급하되';
    const [pair] = await compareCitations([cite('s1', seg, '공무원 여비 규정', '제64조')], fakes([art]), scope, BASIS);
    expect(pair.status).toBe('same');
    expect(pair.current?.enforced).toBeNull();
  });

  it('조문 구조 없는 기관 문서 조각은 그 조문을 언급만 해서는 쓰지 않는다', async () => {
    const chunk = lawEvidence({ kind: 'org_doc', location: 'p.3', effectiveDate: null, text: '직원 여비는 공무원 여비 규정 제64조를 따르며 별도 안내문을 참고한다' });
    const seg = '「공무원 여비 규정」 제64조 철도운임은 실비로 지급하되';
    const [pair] = await compareCitations([cite('s1', seg, '공무원 여비 규정', '제64조')], fakes([chunk]), scope, BASIS);
    expect(pair.status).toBe('not_found');
  });

  // ── 연결 표현 ──
  const connectorCases: [string, string][] = [
    ['의 규정에 따라', '「지방공기업법」 제64조의 규정에 따라 예산'],
    ['에서 정한', '「지방공기업법」 제64조에서 정한 예산'],
    ['상의', '「지방공기업법」 제64조상의 예산'],
  ];
  it.each(connectorCases)('연결 표현 %s 는 대조에서 뗀다', async (_label, seg) => {
    const art = lawEvidence({ title: '지방공기업법', text: '제64조(총칙) 예산을 편성한다.' });
    const [pair] = await compareCitations([cite('s1', seg, '지방공기업법', '제64조')], fakes([art]), scope, BASIS);
    expect(pair.status).toBe('same');
  });

  // ── 창 끊기 ──
  it('다음 인용이나 문장 끝에서 창을 끊는다', async () => {
    const art = lawEvidence({ title: 'A규정', text: '제1조(총칙) 예산을 편성한다.' });
    const seg = '「A규정」 제1조 및 「B규정」 제2조에 따라 결산을 작성한다.';
    const [pair] = await compareCitations([cite('s1', seg, 'A규정', '제1조')], fakes([art]), scope, BASIS);
    expect(pair.cited.text).toBe('및');
    expect(pair.status).toBe('same');
    const seg2 = '「A규정」 제1조 예산을 편성한다. 결산을 작성한다.';
    const [p2] = await compareCitations([cite('s1', seg2, 'A규정', '제1조')], fakes([art]), scope, BASIS);
    expect(p2.cited.text).toBe('예산을 편성한다');
  });

  // ── 항·호·목 인용 ──
  it('제64조제1항에 따라 — 항 번호를 떼고 맞댄다(조문 글은 항을 ①로 매긴다)', async () => {
    const art = lawEvidence({ title: '지방공기업법', text: '제64조(예산) ① 지방공기업은 예산을 편성한다.' });
    const seg = '「지방공기업법」 제64조제1항에 따라 예산을 편성한다';
    const [pair] = await compareCitations([cite('s1', seg, '지방공기업법', '제64조')], fakes([art]), scope, BASIS);
    expect(pair.status).toBe('same');
  });

  it('제64조 제2호의 기준 — 호 번호는 낱말로 세지 않는다', async () => {
    const art = lawEvidence({ title: '지방공기업법', text: '제64조(기준) 기준을 정한다.' });
    const seg = '「지방공기업법」 제64조 제2호의 기준';
    const [pair] = await compareCitations([cite('s1', seg, '지방공기업법', '제64조')], fakes([art]), scope, BASIS);
    expect(pair.status).toBe('same');
  });

  it('항 번호를 떼도 실제 수치(70%)가 조문에 없으면 여전히 바뀜', async () => {
    const art = lawEvidence({ title: '지방공기업법', text: '제64조(예산) ① 지방공기업은 예산을 편성한다.' });
    const seg = '「지방공기업법」 제64조제1항에 따라 예산의 70%를 편성한다';
    const [pair] = await compareCitations([cite('s1', seg, '지방공기업법', '제64조')], fakes([art]), scope, BASIS);
    expect(pair.status).toBe('changed');
  });

  it('『 에서도 창을 끊는다', async () => {
    const art = lawEvidence({ title: 'A규정', text: '제1조(총칙) 예산을 편성한다.' });
    const seg = '「A규정」 제1조 및 『B지침』 결산';
    const [pair] = await compareCitations([cite('s1', seg, 'A규정', '제1조')], fakes([art]), scope, BASIS);
    expect(pair.cited.text).toBe('및');
  });
});
