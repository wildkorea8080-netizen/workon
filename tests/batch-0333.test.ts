// tests/batch-0333.test.ts
// '문서 좁히기'의 넓혀 다시 찾기(2026-11-26, 마이그레이션 없음) — 고른 태그 문서의 근거가 하나도 없으면 예산을 넓혀 한 번 더.
import { describe, expect, it, vi } from 'vitest';
import { createDocSearch, hasTaggedSource, TAG_FILTER_BUDGET, TAG_FILTER_RETRY_BUDGET, type AgentDocument, type DocSearchDeps } from '@/lib/capabilities/doc-search';
import type { NodaContextResult, NodaSource } from '@/lib/noda';

const D1 = '11111111-2222-4333-8444-555555555555'; // #여비
const D2 = '66666666-7777-4888-8999-aaaaaaaaaaaa'; // #복무
const AGENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const docs: AgentDocument[] = [
  { id: D1, title: '여비 규정', file_name: '여비.hwp', noda_status: 'ready', tags: ['여비'] },
  { id: D2, title: '복무 규정', file_name: '복무.hwp', noda_status: 'ready', tags: ['복무'] },
];
const src = (n: number, doc: string, name: string): NodaSource => ({ n, chunk_id: `c${n}`, doc_id: `d${n}`, filename: `${doc}__${name}`, similarity: 0.86 });
const only = (doc: string, name: string): NodaContextResult => ({ context: `[1] ${doc}__${name} p.1\n내용`, sources: [src(1, doc, name)], dropped: 0 });

function run(answers: Array<NodaContextResult | Error>) {
  const fetchContext = vi.fn(async () => { const a = answers.shift()!; if (a instanceof Error) throw a; return a; });
  const log = vi.fn(async () => {});
  const d: DocSearchDeps = {
    documentsOf: async () => docs, fetchContext, findDocuments: async () => [], deleteOrphan: async () => {},
    orgTypeOf: async () => null, commonDocumentsOf: async () => [], fetchCommonContext: async () => ({ context: '', sources: [], dropped: 0 }),
    findCommonDocuments: async () => [], deleteCommonOrphan: async () => {}, log,
  };
  return { cap: createDocSearch(d), fetchContext, log };
}
const pre = (cap: ReturnType<typeof createDocSearch>) => cap.preflight!({ organizationId: 'org', agentId: AGENT, message: '출장 일비', skipDocuments: false, docTags: ['여비'] });

describe('넓혀 다시 찾기', () => {
  it('태그 문서 근거가 없으면 넓혀 한 번 더 — 찾으면 그 결과로', async () => {
    const t = run([only(D2, '복무.hwp'), only(D1, '여비.hwp')]);
    const p = await pre(t.cap);
    expect(t.fetchContext.mock.calls.map((c) => (c as unknown[])[2])).toEqual([TAG_FILTER_BUDGET, TAG_FILTER_RETRY_BUDGET]);
    expect(p.ok && (p.carry as { result?: NodaContextResult }).result?.sources[0].filename).toBe(`${D1}__여비.hwp`);
  });
  it('처음부터 있거나·근거가 아예 없으면 다시 찾지 않고, 다시 찾기가 실패하거나 못 찾으면 첫 결과', async () => {
    const hit = run([only(D1, '여비.hwp')]);
    await pre(hit.cap);
    expect(hit.fetchContext).toHaveBeenCalledTimes(1);
    const none = run([{ context: '', sources: [], dropped: 0 }]);
    await pre(none.cap);
    expect(none.fetchContext).toHaveBeenCalledTimes(1);
    const failed = run([only(D2, '복무.hwp'), new Error('down')]);
    const p = await pre(failed.cap);
    expect(p.ok && (p.carry as { result?: NodaContextResult }).result?.sources[0].filename).toBe(`${D2}__복무.hwp`);
    expect(failed.log).toHaveBeenCalledWith(expect.objectContaining({ message: '문서 좁히기의 넓혀 다시 찾기 실패 — 첫 찾기 결과로 답함' }));
    const miss = run([only(D2, '복무.hwp'), only(D2, '복무.hwp')]);
    expect((await pre(miss.cap)).ok).toBe(true);
    expect(miss.fetchContext).toHaveBeenCalledTimes(2);
  });
  it('가르기 — 파일 이름의 문서 id로, 대소문자 무시', () => {
    expect(hasTaggedSource([{ filename: `${D1.toUpperCase()}__여비.hwp` }], docs, ['여비'])).toBe(true);
    expect(hasTaggedSource([{ filename: `${D2}__복무.hwp` }, { filename: 3 }], docs, ['여비'])).toBe(false);
  });
});
