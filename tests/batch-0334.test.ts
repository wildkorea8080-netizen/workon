// tests/batch-0334.test.ts
// 근거로 고쳐 쓰기의 짧은 이어지는 질문(2026-11-26, 마이그레이션 없음) — 대화처럼 앞 질문과 묶어 다시 찾는다.
import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import { prepareLikeChat, type AgentDocument, type DocSearchDeps } from '@/lib/capabilities/doc-search';
import type { NodaContextResult } from '@/lib/noda';

const D1 = '11111111-2222-4333-8444-555555555555';
const AGENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const docs: AgentDocument[] = [{ id: D1, title: '여비 규정', file_name: '여비.hwp', noda_status: 'ready' }];
const hit: NodaContextResult = { context: `[1] ${D1}__여비.hwp p.3\n국외 출장 일비 60달러`, sources: [{ n: 1, chunk_id: 'c1', doc_id: 'd1', filename: `${D1}__여비.hwp`, similarity: 0.86 }], dropped: 0 };
const empty: NodaContextResult = { context: '', sources: [], dropped: 0 };

function deps(answers: NodaContextResult[]) {
  const fetchContext = vi.fn(async () => answers.shift() ?? empty);
  const d: DocSearchDeps = {
    documentsOf: async () => docs, fetchContext, findDocuments: async () => [{ id: D1, agent_id: AGENT, noda_status: 'ready' }] as never,
    deleteOrphan: async () => {}, orgTypeOf: async () => null, commonDocumentsOf: async () => [], fetchCommonContext: async () => empty,
    findCommonDocuments: async () => [], deleteCommonOrphan: async () => {}, log: async () => {},
  };
  return { d, fetchContext };
}

describe('앞 질문과 묶어 다시 찾기', () => {
  it('짧은 질문이 근거를 못 찾으면 앞 질문과 묶어 한 번 더 — 앞 질문이 없으면 다시 찾지 않는다', async () => {
    const t = deps([empty, hit]);
    await prepareLikeChat({ agentId: AGENT, organizationId: 'org', query: '그럼 국외 출장은?', previousQuestion: '국내 출장 일비는 얼마인가요?' }, t.d);
    expect(t.fetchContext).toHaveBeenCalledTimes(2);
    expect((t.fetchContext.mock.calls[1] as unknown[])[1]).toBe('국내 출장 일비는 얼마인가요?\n그럼 국외 출장은?');
    const alone = deps([empty, hit]);
    await prepareLikeChat({ agentId: AGENT, organizationId: 'org', query: '그럼 국외 출장은?' }, alone.d);
    expect(alone.fetchContext).toHaveBeenCalledTimes(1);
  });
  it('연결 — 고쳐 쓰기가 질문 바로 앞의 질문을 읽어 넘긴다', () => {
    const lib = readFileSync('src/lib/assistant/answer-revise.ts', 'utf8');
    expect(lib).toContain('await deps.loadPreviousQuestion(conversation.id, question.created_at).catch(() => null)');
    const route = readFileSync('src/app/api/messages/[id]/revise/route.ts', 'utf8');
    expect(route).toContain(".select('content, source_references, created_at')");
    expect(route).toContain(".lt('created_at', before)");
    expect(route).toContain('prepareLikeChat({ agentId, organizationId: orgId, query, ...(previousQuestion ? { previousQuestion } : {}) })');
  });
});
