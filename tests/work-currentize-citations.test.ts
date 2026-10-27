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
    const call = () => compareCitations([cite('s1', seg, '공무원 여비 규정', '제64조')], providers, scope, BASIS);
    await expect(call()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    await expect(call()).rejects.toBeInstanceOf(WorkError);
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

  it('작년 문장이 비어 있으면 조문이 있어도 바뀜(대조할 문장이 없어 사람이 본다)', async () => {
    const seg = '「공무원 여비 규정」 제64조';
    const [pair] = await compareCitations([cite('s1', seg, '공무원 여비 규정', '제64조')], fakes([lawEvidence()]), scope, BASIS);
    expect(pair.cited.text).toBe('');
    expect(pair.status).toBe('changed');
  });

  it('작년 문장이 짧으면(6자 미만) 인용 자체가 현재 글에 있는지만 본다', async () => {
    const seg = '「공무원 여비 규정」 제64조 에 따라';
    const [pair] = await compareCitations([cite('s1', seg, '공무원 여비 규정', '제64조')], fakes([lawEvidence()]), scope, BASIS);
    expect(pair.status).toBe('same');
  });
});
