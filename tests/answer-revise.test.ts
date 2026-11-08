import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import type { RetrievedChunk } from '@/lib/db';
import type { ActorScope } from '@/lib/agent-permissions';
import { LlmApiError, LLM_MESSAGES } from '@/lib/llm/errors';
import {
  REVISE_BUTTON_LABEL, REVISE_EXTRA_MAX_CHUNKS, REVISE_PENDING_STALE_MS, REVISE_RULES, REVISION_LABEL,
  extraEvidence, extraEvidenceBlock, questionText, readRevision, reviseRequest, revisionEligibility, revisionPending,
} from '@/lib/assistant/answer-revise-spec';
import { REVISE_BUSY, REVISE_DOCUMENTS_UNAVAILABLE, REVISE_NOT_FOUND, REVISE_RETRY, reviseAnswer, type ReviseAgent, type ReviseDeps } from '@/lib/assistant/answer-revise';
import { trimHistory } from '@/lib/assistant/history';
import AnswerRevision from '@/components/chat/AnswerRevision';

/** 근거로 고쳐 쓰기(2026-11-08) — '검증 후 자동 재검색'의 재작성 단계. 직원이 누르면 다시 찾은 근거로 답을 한 번 고쳐 쓴다 */

const chunk = (over: Partial<RetrievedChunk> = {}): RetrievedChunk => ({ documentId: 'd1', documentTitle: '예산서', chunkIndex: 0, n: 1, text: '단가 33,333원', similarity: 0.9, ...over });
const answerRefs = (over: Record<string, unknown> = {}) => ({ chunks: [chunk()], links: [], files: [], number_check: { unverified: ['98,765'] }, ...over });

describe('고쳐 쓸 수 있는 답변', () => {
  it('문서 근거로 답했고 확인되지 않은 숫자가 있을 때만', () => {
    expect(revisionEligibility(answerRefs())).toEqual({ ok: true, unverified: ['98,765'] });
    expect(revisionEligibility(answerRefs({ number_check: undefined })).ok).toBe(false);
    expect(revisionEligibility(answerRefs({ chunks: [] })).ok).toBe(false);
    expect(revisionEligibility(answerRefs({ documents_skipped: true })).ok).toBe(false);
  });
  it('도구 출처·첨부 파일·입력형 앱 결과는 받지 않는다(그 숫자는 다시 찾은 문서로 확인할 수 없다)', () => {
    expect(revisionEligibility(answerRefs({ links: [{ title: '법령', url: 'https://x' }] })).ok).toBe(false);
    expect(revisionEligibility(answerRefs({ app_steps: [] })).ok).toBe(false);
    expect(revisionEligibility(answerRefs(), { attachments: [{ id: 'a', file_name: 'x.xlsx' }] }).ok).toBe(false);
    expect(revisionEligibility(answerRefs(), { attachments: [] }).ok).toBe(true);
  });
  it('질문 글에서 첨부 표시 줄을 뗀다', () => {
    expect(questionText('[첨부 이미지 1장]\n사업 총액은?\n[첨부 파일: a.xlsx]')).toBe('사업 총액은?');
  });
});

describe('더 찾은 근거', () => {
  it('겹치는 조각·글 없는 조각을 빼고, 번호를 이어 매기고, 상한까지', () => {
    const base = [chunk({ n: 3, chunkIndex: 0 })];
    const extras = extraEvidence(base, [
      [chunk({ n: 1 }), chunk({ documentId: 'd2', text: '총액 98,765천원', page: 4, n: 1 })],
      null, 'timeout',
      [chunk({ documentId: 'd2', text: '총액  98,765천원', n: 7 }), chunk({ documentId: 'd3', text: '  ' })],
    ]);
    expect(extras).toHaveLength(1);
    expect(extras[0]).toMatchObject({ documentId: 'd2', n: 4, chunkIndex: 1 });
    const many = extraEvidence([], [Array.from({ length: 10 }, (_, i) => chunk({ documentId: `x${i}`, text: `글 ${i}` }))]);
    expect(many).toHaveLength(REVISE_EXTRA_MAX_CHUNKS);
    expect(many.map((c) => c.n)).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it('프롬프트 글은 근거 묶음처럼 [n] 제목 위치 + 원문', () => {
    const block = extraEvidenceBlock([chunk({ documentId: 'd2', documentTitle: '집행 계획', text: '총액 98,765천원', page: 4, n: 2 })])!;
    expect(block).toContain('[2] 집행 계획 p.4\n총액 98,765천원');
    expect(extraEvidenceBlock([])).toBeUndefined();
  });
});

describe('저장 꼴 읽기', () => {
  it('다 된 것만 꼴대로, 고쳐 쓰는 중은 5분까지', () => {
    expect(readRevision({ status: 'pending', started_at: 'x' })).toBeNull();
    expect(readRevision({ status: 'done', text: ' ' })).toBeNull();
    expect(readRevision({ status: 'done', text: '답', chunks: [chunk(), { no: 1 }], number_check: { unverified: ['1,234', 5] }, revised_numbers: ['98,765'], created_at: 't' }))
      .toEqual({ text: '답', chunks: [chunk()], unverified: ['1,234'], revisedNumbers: ['98,765'], createdAt: 't' });
    const now = Date.parse('2026-11-08T10:00:00Z');
    expect(revisionPending({ status: 'pending', started_at: '2026-11-08T09:58:00Z' }, now)).toBe(true);
    expect(revisionPending({ status: 'pending', started_at: new Date(now - REVISE_PENDING_STALE_MS).toISOString() }, now)).toBe(false);
    expect(revisionPending({ status: 'done' }, now)).toBe(false);
  });
});

// ── reviseAnswer ──

const actor: ActorScope = {
  userId: 'u1', isAdmin: false, departmentId: 'dep1', organizationId: 'org1', visibleDepartmentIds: ['dep1'], managedDepartmentIds: [], managesWholeOrganization: false,
};
const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';
const agentRow = (over: Partial<ReviseAgent> = {}): ReviseAgent => ({
  id: 'ag1', tier: 'official', department_id: 'dep1', organization_id: 'org1', visibility: 'organization', owner_id: null, created_by: null,
  is_active: true, is_published: true, deleted_at: null, approval_status: null, version: 3, approval_version: null,
  system_prompt: '예산 비서', model_id: 'claude-sonnet-4-6', capabilities: { doc_search: {} }, agent_type: 'chat', ...over,
});
const ORIGINAL = '사업 총액은 98,765천원입니다. 단가는 33,333원입니다[1].';
const REVISED = '사업 총액은 98,765천원입니다[2]. 단가는 33,333원입니다[1]. 예비비는 12,121원입니다.';

function fakeDeps(over: Partial<ReviseDeps> = {}, refs: Record<string, unknown> = answerRefs()) {
  const writes: { next: Record<string, unknown>; expect: string | null }[] = [];
  const deps: ReviseDeps = {
    loadMessage: vi.fn(async (id: string) => ({ id, role: 'assistant', conversation_id: 'c1', content: ORIGINAL, created_at: '2026-11-08T01:00:00Z', source_references: refs })),
    loadConversation: vi.fn(async (_c: string, userId: string) => (userId === 'u1' ? { id: 'c1', agent_id: 'ag1', department_id: 'dep1' } : null)),
    loadQuestion: vi.fn(async () => ({ content: '[첨부 이미지 1장]\n사업 총액은 얼마인가요?', source_references: {} })),
    writeRefs: vi.fn(async (_id: string, next: Record<string, unknown>, expect: string | null) => { writes.push({ next, expect }); return true; }),
    checkLimit: vi.fn(async () => ({ allowed: true as const })),
    loadAgent: vi.fn(async () => agentRow()),
    resolveModel: vi.fn(async () => 'claude-sonnet-4-6'),
    prepare: vi.fn(async () => ({ chunks: [chunk()], systemAddendum: '참고 자료:\n[1] 예산서\n단가 33,333원' })),
    search: vi.fn(async () => [chunk(), chunk({ documentId: 'd2', documentTitle: '집행 계획', text: '총액은 98,765천원으로 정한다', page: 4 })]),
    complete: vi.fn(async () => ({ text: REVISED, usage: { model: 'claude-sonnet-4-6', input_tokens: 100, output_tokens: 50 } })),
    logUsage: vi.fn(async () => {}),
    logFailure: vi.fn(async () => {}),
    now: () => Date.parse('2026-11-08T02:00:00Z'),
    ...over,
  };
  return { deps, writes };
}

describe('reviseAnswer', () => {
  it('차지 → 같은 질문으로 찾기 + 숫자 문장으로 더 찾기 → 모델 한 번 → 기록 → 숫자 확인 → 저장(원래 답은 그대로)', async () => {
    const { deps, writes } = fakeDeps();
    const r = await reviseAnswer(actor, MESSAGE_ID.toUpperCase(), deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(deps.prepare).toHaveBeenCalledWith('ag1', 'org1', '사업 총액은 얼마인가요?');
    expect(deps.search).toHaveBeenCalledWith('ag1', 'org1', '사업 총액은 98,765천원입니다.');
    const req = (deps.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(req.model).toBe('claude-sonnet-4-6');
    expect(req.system.startsWith('예산 비서')).toBe(true);
    expect(req.system).toContain('[2] 집행 계획 p.4\n총액은 98,765천원으로 정한다');
    expect(req.system.endsWith(REVISE_RULES)).toBe(true);
    expect(req.messages).toEqual([
      { role: 'user', content: '사업 총액은 얼마인가요?' },
      { role: 'assistant', content: ORIGINAL },
      { role: 'user', content: reviseRequest(['98,765']) },
    ]);
    expect(deps.logUsage).toHaveBeenCalledWith({ model: 'claude-sonnet-4-6', input_tokens: 100, output_tokens: 50 }, { departmentId: 'dep1', userId: 'u1', agentId: 'ag1', conversationId: 'c1', messageId: MESSAGE_ID });
    // 98,765는 더 찾은 근거에서 확인됨, 근거에 없는 12,121만 남는다
    expect(r.revision).toMatchObject({ text: REVISED, unverified: ['12,121'], revisedNumbers: ['98,765'] });
    expect(r.revision.chunks.map((c) => c.n)).toEqual([1, 2]);
    expect(r).toMatchObject({ reused: false, saved: true });
    // 차지는 칸이 빈 때만, 저장은 그 차지일 때만. 원래 칸(번호 확인·근거)은 그대로
    expect(writes[0].expect).toBeNull();
    expect(writes[0].next.revision).toEqual({ status: 'pending', started_at: '2026-11-08T02:00:00.000Z' });
    expect(writes[1].expect).toBe('2026-11-08T02:00:00.000Z');
    expect(writes[1].next).toMatchObject({ number_check: { unverified: ['98,765'] }, revision: { status: 'done', text: REVISED, model: 'claude-sonnet-4-6' } });
    expect((writes[1].next.chunks as unknown[]).length).toBe(1);
  });

  it('이미 고쳐 쓴 답은 모델을 부르지 않고 그대로 돌려준다(한 답변에 한 번)', async () => {
    const { deps } = fakeDeps({}, answerRefs({ revision: { status: 'done', text: '고친 답', chunks: [], number_check: { unverified: [] }, revised_numbers: ['98,765'] } }));
    const r = await reviseAnswer(actor, MESSAGE_ID, deps);
    expect(r).toMatchObject({ ok: true, reused: true, revision: { text: '고친 답' } });
    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.checkLimit).not.toHaveBeenCalled();
  });

  it('고쳐 쓰는 중이면 409, 오래된 표시는 그 시각을 조건으로 다시 차지한다', async () => {
    const fresh = fakeDeps({}, answerRefs({ revision: { status: 'pending', started_at: '2026-11-08T01:58:00Z' } }));
    expect(await reviseAnswer(actor, MESSAGE_ID, fresh.deps)).toEqual({ ok: false, status: 409, message: REVISE_BUSY });
    expect(fresh.deps.complete).not.toHaveBeenCalled();
    const stale = fakeDeps({}, answerRefs({ revision: { status: 'pending', started_at: '2026-11-08T01:00:00Z' } }));
    expect((await reviseAnswer(actor, MESSAGE_ID, stale.deps)).ok).toBe(true);
    expect(stale.writes[0].expect).toBe('2026-11-08T01:00:00Z');
  });

  it('남의 대화·답변이 아닌 메시지·없는 id는 404, 받지 않는 답변은 400, 한도는 차지 전에 429', async () => {
    expect(await reviseAnswer({ ...actor, userId: 'u2' }, MESSAGE_ID, fakeDeps().deps)).toEqual({ ok: false, status: 404, message: REVISE_NOT_FOUND });
    expect((await reviseAnswer(actor, 'nope', fakeDeps().deps)).ok).toBe(false);
    const user = fakeDeps({ loadMessage: async (id) => ({ id, role: 'user', conversation_id: 'c1', content: 'q', created_at: 't', source_references: {} }) });
    expect(await reviseAnswer(actor, MESSAGE_ID, user.deps)).toMatchObject({ status: 404 });
    const links = fakeDeps({}, answerRefs({ links: [{ title: 'l', url: 'https://x' }] }));
    expect(await reviseAnswer(actor, MESSAGE_ID, links.deps)).toMatchObject({ status: 400 });
    const attached = fakeDeps({ loadQuestion: async () => ({ content: 'q', source_references: { attachments: [{ id: 'a', file_name: 'x' }] } }) });
    expect(await reviseAnswer(actor, MESSAGE_ID, attached.deps)).toMatchObject({ status: 400 });
    const limited = fakeDeps({ checkLimit: async () => ({ allowed: false as const, message: '한도' }) });
    expect(await reviseAnswer(actor, MESSAGE_ID, limited.deps)).toEqual({ ok: false, status: 429, message: '한도' });
    expect(limited.writes).toHaveLength(0);
  });

  it('비서를 쓸 수 없거나 문서 찾기가 꺼졌으면 거절', async () => {
    expect(await reviseAnswer(actor, MESSAGE_ID, fakeDeps({ loadAgent: async () => agentRow({ tier: 'personal', owner_id: 'u9' }) }).deps)).toMatchObject({ status: 403 });
    expect(await reviseAnswer(actor, MESSAGE_ID, fakeDeps({ loadAgent: async () => agentRow({ capabilities: {} }) }).deps)).toMatchObject({ status: 400 });
    expect(await reviseAnswer(actor, MESSAGE_ID, fakeDeps({ loadAgent: async () => agentRow({ deleted_at: 'x' }) }).deps)).toMatchObject({ status: 404 });
  });

  it('차지 경쟁에 지면 409(모델 안 부름)', async () => {
    const { deps } = fakeDeps({ writeRefs: async () => false });
    expect(await reviseAnswer(actor, MESSAGE_ID, deps)).toEqual({ ok: false, status: 409, message: REVISE_BUSY });
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it('찾기 실패면 차지를 풀고 503', async () => {
    const { deps, writes } = fakeDeps({ prepare: async () => null });
    expect(await reviseAnswer(actor, MESSAGE_ID, deps)).toEqual({ ok: false, status: 503, message: REVISE_DOCUMENTS_UNAVAILABLE });
    expect(writes[1]).toEqual({ next: answerRefs(), expect: '2026-11-08T02:00:00.000Z' });
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it('모델 실패는 차지를 풀고 안내(키·결제 문제는 관리자 안내), 사용 기록 없음', async () => {
    const plain = fakeDeps({ complete: async () => { throw new Error('boom'); } });
    expect(await reviseAnswer(actor, MESSAGE_ID, plain.deps)).toEqual({ ok: false, status: 502, message: REVISE_RETRY });
    expect(plain.writes.at(-1)?.next.revision).toBeUndefined();
    expect(plain.deps.logUsage).not.toHaveBeenCalled();
    const billing = fakeDeps({ complete: async () => { throw new LlmApiError(400, 'credit balance is too low'); } });
    expect(await reviseAnswer(actor, MESSAGE_ID, billing.deps)).toMatchObject({ status: 502, message: LLM_MESSAGES.unavailable });
  });

  it('빈 답은 토큰을 기록하고 차지를 푼다', async () => {
    const { deps, writes } = fakeDeps({ complete: async () => ({ text: '  ', usage: { model: 'm', input_tokens: 5, output_tokens: 0 } }) });
    expect(await reviseAnswer(actor, MESSAGE_ID, deps)).toMatchObject({ status: 502 });
    expect(deps.logUsage).toHaveBeenCalledTimes(1);
    expect(writes.at(-1)?.next.revision).toBeUndefined();
  });

  it('저장에 실패해도 고쳐 쓴 답은 돌려주고 기록을 남긴다', async () => {
    let n = 0;
    const { deps } = fakeDeps({ writeRefs: async () => (n++ === 0) });
    const r = await reviseAnswer(actor, MESSAGE_ID, deps);
    expect(r).toMatchObject({ ok: true, saved: false, revision: { text: REVISED } });
    expect(deps.logFailure).toHaveBeenCalledWith('근거로 고쳐 쓰기 — 고쳐 쓴 답을 저장하지 못함', expect.anything());
  });
});

describe('다음 턴·화면·연결', () => {
  it('다음 턴의 이력은 고쳐 쓴 답을 앞 답변으로 본다', () => {
    expect(trimHistory([{ role: 'assistant', content: '원래', revised: '고친 답' }, { role: 'user', content: '질문' }]))
      .toEqual([{ role: 'user', content: '질문' }, { role: 'assistant', content: '고친 답' }]);
    expect(trimHistory([{ role: 'assistant', content: '원래', revised: null }, { role: 'user', content: '질문' }])[1].content).toBe('원래');
    expect(readFileSync('src/lib/assistant/history.ts', 'utf8')).toContain("revised:source_references->revision->>text");
  });
  it('단추는 받을 수 있는 답에만, 고쳐 쓴 답은 이름표와 함께 따로 그린다', () => {
    const button = renderToStaticMarkup(createElement(AnswerRevision, { messageId: MESSAGE_ID, initial: null, eligible: true }));
    expect(button).toContain(REVISE_BUTTON_LABEL);
    expect(renderToStaticMarkup(createElement(AnswerRevision, { messageId: MESSAGE_ID, initial: null, eligible: false }))).toBe('');
    const shown = renderToStaticMarkup(createElement(AnswerRevision, {
      messageId: MESSAGE_ID, eligible: true,
      initial: { text: '고친 답 12,121원', chunks: [chunk()], unverified: ['12,121'], revisedNumbers: ['98,765'], createdAt: 't' },
    }));
    expect(shown).toContain(REVISION_LABEL);
    expect(shown).toContain('98,765');
    expect(shown).toContain('확인되지 않은 숫자: 12,121');
    expect(shown).not.toContain(REVISE_BUTTON_LABEL);
  });
  it('대화 화면·라우트·감사 표시 연결', () => {
    const chat = readFileSync('src/components/chat/ChatInterface.tsx', 'utf8');
    expect(chat).toContain('revision: m.role === \'assistant\' ? readRevision(m.source_references?.revision) : undefined');
    expect(chat).toContain('<AnswerRevision');
    expect(chat).toContain('eligible={revisionEligibility(');
    const route = readFileSync('src/app/api/messages/[id]/revise/route.ts', 'utf8');
    expect(route).toContain("action: 'answer_revised'");
    expect(route).toContain('export const maxDuration = 300');
    expect(route).toContain(".eq('source_references->revision->>started_at', expect)");
    for (const file of ['src/app/api/admin/audit-logs/route.ts', 'src/lib/usage-summary.ts']) {
      expect(readFileSync(file, 'utf8')).toContain("answer_revised: '근거로 고쳐 쓰기(AI)'");
    }
  });
});
