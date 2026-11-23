import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CHAT_DOC_TAGS_MAX, docTagsNote, parseChatDocTags } from '@/lib/chat-doc-tags';
import { createDocSearch, keepTaggedChunks, TAG_FILTER_BUDGET, type AgentDocument, type DocSearchDeps } from '@/lib/capabilities/doc-search';
import { NODA_CONTEXT_BUDGET, type NodaContextResult, type NodaSource } from '@/lib/noda';
import type { TurnContext } from '@/lib/capabilities/types';
import type { CommonSearchDoc } from '@/lib/capabilities/doc-search-common';
import type { RetrievedChunk } from '@/lib/db';
import { buildMessageRows } from '@/lib/assistant/persist';

// 0274 — 대화의 '문서 좁히기'(기능). 입력창에서 태그를 고르면 그 태그가 붙은 이 비서의 문서에서만 찾는다.
// NODA `/context`에 문서 거르기가 없어, 입력형 앱의 태그 좁히기(2026-11-09)처럼 찾은 뒤 거른다 — 공통 자료실은 태그가 없어 뺀다.

const D1 = '11111111-2222-4333-8444-555555555555'; // #여비
const D2 = '66666666-7777-4888-8999-aaaaaaaaaaaa'; // #복무
const AGENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const docs: AgentDocument[] = [
  { id: D1, title: '여비 규정', file_name: '여비.hwp', noda_status: 'ready', tags: ['여비', '출장'] },
  { id: D2, title: '복무 규정', file_name: '복무.hwp', noda_status: 'ready', tags: ['복무'] },
];
const src = (n: number, doc: string, name: string): NodaSource => ({ n, chunk_id: `c${n}`, doc_id: `d${n}`, filename: `${doc}__${name}`, similarity: 0.86 });
const context = `[1] ${D1}__여비.hwp p.3\n국내 출장 일비 2만원\n[2] ${D2}__복무.hwp p.7\n연가는 사전 승인`;

function deps(over: Partial<DocSearchDeps> = {}) {
  const fetchContext = vi.fn(async (_a: string, _q: string, _b?: number): Promise<NodaContextResult> => ({ context, sources: [src(1, D1, '여비.hwp'), src(2, D2, '복무.hwp')], dropped: 0 }));
  const fetchCommonContext = vi.fn(async (): Promise<NodaContextResult> => ({ context: '', sources: [], dropped: 0 }));
  const commonDocumentsOf = vi.fn(async (): Promise<CommonSearchDoc[]> => [{ id: 'cccccccc-1111-4222-8333-444444444444', title: '기준', edition_year: 2026, org_type: '공공기관', noda_status: 'ready', retired_at: null, replaces_id: null }]);
  const d: DocSearchDeps = {
    documentsOf: async () => docs,
    fetchContext,
    findDocuments: async () => [],
    deleteOrphan: async () => {},
    orgTypeOf: async () => '공공기관',
    commonDocumentsOf,
    fetchCommonContext,
    findCommonDocuments: async () => [],
    deleteCommonOrphan: async () => {},
    log: vi.fn(async () => {}),
    ...over,
  };
  return { d, fetchContext, fetchCommonContext };
}
const ctx = (preflight: unknown): TurnContext => ({
  organizationId: 'org', departmentId: 'dept', userId: 'u', agentId: AGENT, agentVersion: 1, conversationId: 'c', attachments: [],
  capabilities: { doc_search: {} }, message: '출장 일비', preflight: { doc_search: preflight }, skipDocuments: false,
});
async function turn(tags: string[] | undefined) {
  const m = deps();
  const cap = createDocSearch(m.d);
  const pre = await cap.preflight!({ organizationId: 'org', agentId: AGENT, message: '출장 일비', skipDocuments: false, ...(tags ? { docTags: tags } : {}) });
  if (!pre.ok) throw new Error('거절');
  return { m, out: await cap.prepare!(ctx(pre.carry)) };
}

describe('parseChatDocTags', () => {
  it('없으면 좁히지 않는다', () => {
    expect(parseChatDocTags(undefined)).toEqual({ ok: true, tags: [] });
    expect(parseChatDocTags(null)).toEqual({ ok: true, tags: [] });
    expect(parseChatDocTags([])).toEqual({ ok: true, tags: [] });
  });
  it('다듬고 겹친 것은 처음 것만(대소문자 무시)', () => {
    expect(parseChatDocTags(['#여비', ' 여비 ', 'Travel', 'travel', ''])).toEqual({ ok: true, tags: ['여비', 'Travel'] });
  });
  it('꼴이 틀리거나 너무 많거나 길면 거절', () => {
    expect(parseChatDocTags('여비').ok).toBe(false);
    expect(parseChatDocTags([1]).ok).toBe(false);
    expect(parseChatDocTags(Array.from({ length: CHAT_DOC_TAGS_MAX + 1 }, (_, i) => `t${i}`)).ok).toBe(false);
    expect(parseChatDocTags(['가'.repeat(21)]).ok).toBe(false);
  });
  it('말풍선 표시', () => {
    expect(docTagsNote(['여비', '복무'])).toBe('문서 좁히기: #여비 #복무 — 이 태그가 붙은 문서에서만 찾았습니다');
  });
});

describe('keepTaggedChunks', () => {
  const chunk = (documentId: string, scope?: 'common'): RetrievedChunk => ({ documentId, documentTitle: 't', chunkIndex: 0, text: 'x', similarity: 0.9, ...(scope ? { scope } : {}) } as unknown as RetrievedChunk);
  it('고른 태그가 하나라도 붙은 문서만, 대소문자 무시, 공통은 뺀다', () => {
    const out = keepTaggedChunks([chunk(D1), chunk(D2), chunk(D1, 'common')], docs, ['출장']);
    expect(out.map((c) => c.documentId)).toEqual([D1]);
    expect(keepTaggedChunks([chunk(D1)], [{ ...docs[0], tags: ['TRAVEL'] }], ['travel'])).toHaveLength(1);
    expect(keepTaggedChunks([chunk(D1)], [{ ...docs[0], tags: null }], ['여비'])).toHaveLength(0);
  });
});

describe('대화 문서 찾기 — 문서 좁히기', () => {
  it('좁히지 않으면 예전 그대로(비서·공통 둘 다, 예산 나눔)', async () => {
    const { m, out } = await turn(undefined);
    expect(m.fetchCommonContext).toHaveBeenCalledTimes(1);
    expect(m.fetchContext.mock.calls[0][2]).not.toBe(TAG_FILTER_BUDGET);
    expect(out.docTags).toBeUndefined();
  });

  it('좁히면 비서 보관함만, 넉넉한 예산으로', async () => {
    const { m } = await turn(['여비']);
    expect(m.fetchCommonContext).not.toHaveBeenCalled();
    expect(m.fetchContext).toHaveBeenCalledWith(AGENT, '출장 일비', TAG_FILTER_BUDGET);
    expect(TAG_FILTER_BUDGET).toBe(NODA_CONTEXT_BUDGET * 2);
  });

  it('고른 태그 문서의 조각만 근거로, 모델에게도 그 글만', async () => {
    const { out } = await turn(['여비']);
    expect(out.chunks?.map((c) => c.documentId)).toEqual([D1]);
    expect(out.systemAddendum).toContain('국내 출장 일비 2만원');
    expect(out.systemAddendum).not.toContain('연가는 사전 승인');
    expect(out.systemAddendum).toContain('문서 좁히기: #여비');
    expect(out.docTags).toEqual(['여비']);
  });

  it('남는 것이 없으면 고른 태그의 문서에서 찾지 못했다고 답하게', async () => {
    const { out } = await turn(['계약']);
    expect(out.chunks).toEqual([]);
    expect(out.systemAddendum).toContain('[문서 검색 결과 없음]');
    expect(out.systemAddendum).toContain('고른 태그의 문서에서 찾지 못했다고 밝히고');
    expect(out.verifySources).toEqual([]);
  });
});

describe('대화 요청·저장', () => {
  it('요청의 doc_tags를 다듬어 문서 찾기에 넘기고, 틀리면 거절', () => {
    const s = readFileSync('src/lib/assistant/prepare.ts', 'utf8');
    expect(s).toContain('const docTagsParsed = parseChatDocTags(body.doc_tags);');
    expect(s).toContain('if (!docTagsParsed.ok) return reject(docTagsParsed.message, 400);');
    expect(s).toContain('...(docTags.length ? { docTags } : {})');
  });
  it('답변 행에만 doc_tags — 두 행의 칸은 같다', () => {
    const rows = buildMessageRows({
      conversationId: 'c', userId: 'u', userContent: 'q', assistantText: 'a', chunks: [], links: [], files: [], attachments: [],
      agentVersion: 1, documentsSkipped: false, docTags: ['여비'],
    });
    expect(Object.keys(rows[0]).sort()).toEqual(Object.keys(rows[1]).sort());
    const refs = (r: unknown) => (r as { source_references: Record<string, unknown> }).source_references;
    expect(refs(rows[1]).doc_tags).toEqual(['여비']);
    expect(refs(rows[0]).doc_tags).toBeUndefined();
    const plain = buildMessageRows({ conversationId: 'c', userId: 'u', userContent: 'q', assistantText: 'a', chunks: [], links: [], files: [], attachments: [], agentVersion: 1, documentsSkipped: false });
    expect(refs(plain[1]).doc_tags).toBeUndefined();
  });
});

describe('화면', () => {
  const chat = readFileSync('src/components/chat/ChatInterface.tsx', 'utf8');
  it('문서 찾기가 켜진 비서에 입력창 위 문서 좁히기, 요청에 doc_tags, 다른 비서로 바꾸면 비움', () => {
    expect(chat).toContain('{canFilterDocs && <DocTagFilter key={selectedAgent.id} agentId={selectedAgent.id} value={docTags} onChange={setDocTags} disabled={isLoading} />}');
    expect(chat).toContain('doc_tags: !skipDocuments && req.docTags.length > 0 ? req.docTags : undefined,');
    expect(chat).toContain('useEffect(() => { setDocTags([]); }, [selectedAgent.id]);');
  });
  it('지난 대화에서도 무엇으로 좁혔는지 보인다', () => {
    expect(chat).toContain('docTags={msg.docTags}');
    expect(readFileSync('src/components/chat/MessageBubble.tsx', 'utf8')).toContain('{docTagsNote(docTags)}');
  });
  it('태그 목록 API는 그 비서를 쓸 수 있는 사람만, 라우트 목록에도', () => {
    const r = readFileSync('src/app/api/agents/[id]/document-tags/route.ts', 'utf8');
    expect(r).toContain('!canUseAgent(agent, actor)');
    expect(readFileSync('src/lib/api-route-ids.ts', 'utf8')).toContain("'agents/[id]/document-tags',");
  });
});
