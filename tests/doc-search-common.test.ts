// tests/doc-search-common.test.ts
import { describe, it, expect } from 'vitest';
import {
  shiftContext,
  maxCitationNumber,
  commonSourcesToChunks,
  citableCommonIds,
  keepContextBlocks,
  type CommonSearchDoc,
} from '@/lib/capabilities/doc-search-common';
import { contextPassages } from '@/lib/capabilities/doc-search';
import type { NodaContextResult, NodaSource } from '@/lib/noda';

/**
 * 비서 보관함과 공통 보관함의 근거 번호를 한 줄로 잇는다(S5 5.2·5.3).
 * 실패가 조용한 곳이다 — 번호가 겹치면 답변 속 `[n]`이 엉뚱한 근거를 가리키고,
 * 본문 속 `[2]`까지 밀면 문서 내용이 바뀐다.
 */

const ID = '11111111-2222-4333-8444-555555555555';
const ID2 = '66666666-7777-4888-8999-aaaaaaaaaaaa';

const src = (over: Partial<NodaSource> = {}): NodaSource => ({
  n: 1, chunk_id: 'c1', doc_id: 'd', filename: `${ID}__a.pdf`, similarity: 0.85, ...over,
});

const doc = (over: Partial<CommonSearchDoc> = {}): CommonSearchDoc => ({
  id: ID, title: '지방공무원 여비 규정', edition_year: 2026, org_type: 'local_government',
  noda_status: 'ready', retired_at: null, replaces_id: null, ...over,
} as CommonSearchDoc);

describe('shiftContext', () => {
  const r: NodaContextResult = {
    context: '[1] a.pdf · 3쪽\n본문 [2]\n[2] b.pdf\n둘',
    sources: [src({ n: 1 }), src({ n: 2, chunk_id: 'c2' })],
    dropped: 1,
  };

  it('머리 줄과 sources.n이 함께 밀린다, 본문 속 [2]는 그대로', () => {
    const s = shiftContext(r, 3);
    expect(s.context).toBe('[4] a.pdf · 3쪽\n본문 [2]\n[5] b.pdf\n둘');
    expect(s.sources.map((x) => x.n)).toEqual([4, 5]);
    expect(s.dropped).toBe(1);
  });

  it('원본은 바뀌지 않는다', () => {
    shiftContext(r, 3);
    expect(r.context).toBe('[1] a.pdf · 3쪽\n본문 [2]\n[2] b.pdf\n둘');
    expect(r.sources.map((x) => x.n)).toEqual([1, 2]);
  });

  it('0이면 그대로', () => {
    expect(shiftContext(r, 0)).toBe(r);
  });

  it('n이 숫자가 아닌 원소는 건드리지 않는다', () => {
    const odd = { context: '', sources: [{ ...src(), n: 'x' as unknown as number }], dropped: 0 };
    expect(shiftContext(odd, 2).sources[0].n).toBe('x');
  });

  it('근거 창 원문이 민 번호로 이어진다', () => {
    const p = contextPassages(shiftContext(r, 3).context);
    expect(Array.from(p.keys())).toEqual([4, 5]);
    expect(p.get(4)).toBe('본문 [2]');
    expect(p.get(5)).toBe('둘');
  });
});

describe('maxCitationNumber', () => {
  it('머리 줄·sources 중 큰 값', () => {
    expect(maxCitationNumber({ context: '[1] a\n[3] b', sources: [src({ n: 2 })], dropped: 0 })).toBe(3);
    expect(maxCitationNumber({ context: '[1] a', sources: [src({ n: 7 })], dropped: 0 })).toBe(7);
  });
  it('본문 속 [9]는 세지 않는다', () => {
    expect(maxCitationNumber({ context: '[1] a\n본문 [9]', sources: [], dropped: 0 })).toBe(1);
  });
  it('빈 결과는 0', () => {
    expect(maxCitationNumber({ context: '', sources: [], dropped: 0 })).toBe(0);
  });
});

describe('commonSourcesToChunks', () => {
  it('현재 판 ready만 조각(scope common·editionYear·startIndex), 지난 판·읽는 중은 조용히 뺌', () => {
    const docs = [
      doc(),
      doc({ id: ID2, title: '옛 판', edition_year: 2025, retired_at: '2026-01-01T00:00:00Z' }),
    ];
    const reading = '99999999-9999-4999-8999-999999999999';
    docs.push(doc({ id: reading, noda_status: 'reading' }));
    const sources = [
      src({ n: 4, anchors: [{ page: 12 }], outline: ['제3장', '여비'] }),
      src({ n: 5, filename: `${ID2}__old.pdf` }),
      src({ n: 6, filename: `${reading}__r.pdf` }),
    ];
    const passages = new Map([[4, '일비 2만원']]);
    const m = commonSourcesToChunks(sources, docs, passages, 3);
    expect(m.unknown).toEqual([]);
    expect(m.chunks).toHaveLength(1);
    expect(m.chunks[0]).toMatchObject({
      documentId: ID,
      documentTitle: '지방공무원 여비 규정',
      chunkIndex: 3,
      n: 4,
      text: '일비 2만원',
      page: 12,
      section: '제3장 › 여비',
      scope: 'common',
      editionYear: 2026,
    });
  });

  it('chunkIndex는 startIndex부터 이어진다', () => {
    const m = commonSourcesToChunks(
      [src({ n: 1 }), src({ n: 2, chunk_id: 'c2' })], [doc()], new Map(), 5,
    );
    expect(m.chunks.map((c) => c.chunkIndex)).toEqual([5, 6]);
  });

  it('행 없는 id·id 못 읽는 이름·깨진 원소는 따로 모은다', () => {
    const sources = [
      src({ n: 1, filename: `${ID2}__x.pdf` }),
      src({ n: 2, filename: 'no-prefix.pdf' }),
      null as unknown as NodaSource,
      src({ n: 3, filename: 5 as unknown as string }),
      src({ n: 4 }),
    ];
    const m = commonSourcesToChunks(sources, [doc()], new Map(), 0);
    expect(m.unknown).toEqual([{ documentId: ID2, filename: `${ID2}__x.pdf` }]);
    expect(m.unparsable).toEqual(['no-prefix.pdf']);
    expect(m.malformed).toBe(2);
    expect(m.chunks.map((c) => c.n)).toEqual([4]);
  });
});

describe('citableCommonIds — 옛 판 내리기가 실패한 사이에도 지난 판은 근거가 아니다', () => {
  it('ready 현재 판만, ready 새 판이 대신하는 옛 판은 뺀다', () => {
    const ids = citableCommonIds([
      doc({ id: ID2, edition_year: 2025 }),
      doc({ replaces_id: ID2 }),
    ]);
    expect(Array.from(ids)).toEqual([ID]);
  });

  it('새 판이 아직 ready가 아니면(읽는 중·실패) 옛 판이 그대로 근거', () => {
    for (const status of ['reading', 'failed', 'unreadable'] as const) {
      const ids = citableCommonIds([doc({ id: ID2 }), doc({ noda_status: status, replaces_id: ID2 })]);
      expect(Array.from(ids)).toEqual([ID2]);
    }
  });

  it('지난 판이 된 새 판의 replaces_id는 세지 않는다, 대소문자 무시', () => {
    expect(Array.from(citableCommonIds([doc({ id: ID2 }), doc({ retired_at: '2026-01-01T00:00:00Z', replaces_id: ID2 })]))).toEqual([ID2]);
    expect(citableCommonIds([doc({ id: ID2 }), doc({ replaces_id: ID2.toUpperCase() })]).has(ID2)).toBe(false);
  });

  it('commonSourcesToChunks도 대신된 옛 판 조각을 조용히 뺀다', () => {
    const m = commonSourcesToChunks(
      [src({ n: 1 }), src({ n: 2, filename: `${ID2}__old.pdf` })],
      [doc({ replaces_id: ID2 }), doc({ id: ID2, title: '옛 판', edition_year: 2025 })],
      new Map(),
      0,
    );
    expect(m.unknown).toEqual([]);
    expect(m.chunks.map((c) => c.documentId)).toEqual([ID]);
  });
});

describe('keepContextBlocks', () => {
  const ctx = '앞 글\n[4] a.pdf · 3쪽\n일비 [5]\n[5] old.pdf\n옛 단가\n[6] c.pdf\n셋';

  it('고른 번호의 블록만, 본문 속 [5]는 머리 줄이 아니다, 첫 머리 줄 앞 글은 버림', () => {
    expect(keepContextBlocks(ctx, new Set([4, 6]))).toBe('[4] a.pdf · 3쪽\n일비 [5]\n[6] c.pdf\n셋');
  });

  it('하나도 고르지 않으면 빈 글', () => {
    expect(keepContextBlocks(ctx, new Set())).toBe('');
  });
});
