import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { createDocSearch, followUpQuery, FOLLOW_UP_NOTE, type AgentDocument, type DocSearchDeps } from '@/lib/capabilities/doc-search';
import { NodaError, type NodaContextResult } from '@/lib/noda';
import type { TurnContext } from '@/lib/capabilities/types';

/** 이어지는 질문의 문서 찾기(2026-11-05) — 짧은 질문이 근거를 못 찾으면 바로 앞 질문과 묶어 한 번만 다시 찾는다 */

const id = '11111111-2222-4333-8444-555555555555';
const AGENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ready: AgentDocument = { id, title: '여비 규정', file_name: '규정.hwp', noda_status: 'ready' };
const found: NodaContextResult = { context: `[1] ${id}__규정.hwp p.20\n국외 출장 일비는 별표 2`, sources: [{ n: 1, chunk_id: 'c1', doc_id: 'd', filename: `${id}__규정.hwp`, similarity: 0.86, anchors: [{ page: 20 }] } as never], dropped: 0 };
const empty: NodaContextResult = { context: '', sources: [], dropped: 3 };

function deps(answers: (NodaContextResult | Error)[]) {
  const fetchContext = vi.fn(async (_agent: string, _query: string, _budget?: number): Promise<NodaContextResult> => {
    const next = answers.shift() ?? empty;
    if (next instanceof Error) throw next;
    return next;
  });
  const log = vi.fn(async () => {});
  const d: DocSearchDeps = {
    documentsOf: async () => [ready],
    fetchContext,
    findDocuments: async () => [],
    deleteOrphan: async () => {},
    orgTypeOf: async () => null,
    commonDocumentsOf: async () => [],
    fetchCommonContext: async () => empty,
    findCommonDocuments: async () => [],
    deleteCommonOrphan: async () => {},
    log,
  };
  return { d, fetchContext, log };
}

const ctx = (carry: unknown, message: string): TurnContext => ({
  organizationId: 'org', departmentId: 'dept', userId: 'u', agentId: AGENT, agentVersion: 1, conversationId: 'c', attachments: [],
  capabilities: { doc_search: {} }, message, preflight: { doc_search: carry }, skipDocuments: false,
});

async function turn(d: DocSearchDeps, message: string, previousQuestion?: string) {
  const cap = createDocSearch(d);
  const pre = await cap.preflight!({ organizationId: 'org', agentId: AGENT, message, skipDocuments: false, previousQuestion });
  if (!pre.ok) throw new Error('거절됨');
  return cap.prepare!(ctx(pre.carry, message));
}

describe('다시 찾기 질의', () => {
  it('짧은 질문 + 앞 질문이면 둘을 잇고, 앞 질문의 첨부 표시 줄은 뗀다', () => {
    expect(followUpQuery('국내 출장 여비 기준이 뭐야?', '그럼 국외 출장은?')).toBe('국내 출장 여비 기준이 뭐야?\n그럼 국외 출장은?');
    expect(followUpQuery('[첨부 파일: 표.xlsx]\n이 표의 출장비 합계', '국외는?')).toBe('이 표의 출장비 합계\n국외는?');
    expect(followUpQuery('가'.repeat(500), '국외는?')).toBe(`${'가'.repeat(300)}\n국외는?`);
  });

  it('하지 않음: 앞 질문 없음·긴 질문·빈 질문·같은 질문·앞 질문이 첨부 표시뿐', () => {
    expect(followUpQuery(undefined, '국외는?')).toBeNull();
    expect(followUpQuery('국내 출장', '국외 출장 일비와 숙박비 상한, 그리고 항공 운임 등급과 환율 적용 기준은 어떻게 정해져 있나요 자세히 알려 주세요')).toBeNull();
    expect(followUpQuery('국내 출장', '  ')).toBeNull();
    expect(followUpQuery('국외는?', '국외는?')).toBeNull();
    expect(followUpQuery('[첨부 이미지 2장]', '이건 뭐야?')).toBeNull();
  });
});

describe('대화의 문서 찾기', () => {
  it('짧은 질문이 근거를 못 찾으면 앞 질문과 묶어 다시 찾아 근거를 쓰고, 관련 있을 때만 쓰라는 줄을 붙인다', async () => {
    const { d, fetchContext } = deps([empty, found]);
    const out = await turn(d, '그럼 국외 출장은?', '국내 출장 여비 기준이 뭐야?');
    expect(fetchContext).toHaveBeenCalledTimes(2);
    expect(fetchContext.mock.calls[0][1]).toBe('그럼 국외 출장은?');
    expect(fetchContext.mock.calls[1][1]).toBe('국내 출장 여비 기준이 뭐야?\n그럼 국외 출장은?');
    expect(out.chunks).toHaveLength(1);
    expect(out.systemAddendum).toContain('국외 출장 일비는 별표 2');
    expect(out.systemAddendum?.endsWith(FOLLOW_UP_NOTE)).toBe(true);
  });

  it('첫 찾기가 근거를 찾았거나, 앞 질문이 없거나, 긴 질문이면 다시 찾지 않는다', async () => {
    const first = deps([found]);
    const out = await turn(first.d, '국외는?', '국내 출장 여비');
    expect(first.fetchContext).toHaveBeenCalledTimes(1);
    expect(out.systemAddendum).not.toContain(FOLLOW_UP_NOTE);
    const noPrev = deps([empty]);
    await turn(noPrev.d, '국외는?');
    expect(noPrev.fetchContext).toHaveBeenCalledTimes(1);
    const long = deps([empty]);
    await turn(long.d, '국외 출장 일비와 숙박비 상한, 그리고 항공 운임 등급과 환율 적용 기준은 어떻게 정해져 있나요 자세히 알려 주세요', '국내');
    expect(long.fetchContext).toHaveBeenCalledTimes(1);
  });

  it('다시 찾아도 근거가 없으면 근거 없음 그대로(관련 지시 없이), 다시 찾기가 실패해도 대화는 막지 않고 기록만', async () => {
    const none = deps([empty, empty]);
    const out = await turn(none.d, '그럼 국외는?', '국내 출장 여비');
    expect(none.fetchContext).toHaveBeenCalledTimes(2);
    expect(out.chunks).toEqual([]);
    expect(out.systemAddendum).toContain('[문서 검색 결과 없음]');
    expect(out.systemAddendum).not.toContain(FOLLOW_UP_NOTE);

    const fail = deps([empty, new NodaError('HTTP 502', 'http', 502)]);
    const failed = await turn(fail.d, '그럼 국외는?', '국내 출장 여비');
    expect(failed.chunks).toEqual([]);
    expect(fail.log).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning', message: expect.stringContaining('다시 찾기 실패') }));
    expect(JSON.stringify(fail.log.mock.calls)).not.toContain('국외');
  });

  it('첫 찾기가 실패하면 지금처럼 거절한다(다시 찾지 않음)', async () => {
    const { d, fetchContext } = deps([new NodaError('HTTP 502', 'http', 502)]);
    const pre = await createDocSearch(d).preflight!({ organizationId: 'org', agentId: AGENT, message: '국외는?', skipDocuments: false, previousQuestion: '국내 출장' });
    expect(pre.ok).toBe(false);
    expect(fetchContext).toHaveBeenCalledTimes(1);
  });
});

describe('연결 (원본)', () => {
  it('대화 준비가 그 사람·그 비서의 대화일 때만 앞 질문을 넘긴다', () => {
    const src = readFileSync('src/lib/assistant/prepare.ts', 'utf8');
    expect(src).toContain("await previousUserQuestion(conversation_id, actor.userId, agent_id)");
    expect(src).toContain(".eq('user_id', userId)\n      .eq('agent_id', agentId)");
    expect(src).toContain("message, skipDocuments, previousQuestion });");
  });
});
