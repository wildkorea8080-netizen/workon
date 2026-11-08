// src/lib/assistant/answer-revise.ts
// 근거로 고쳐 쓰기(2026-11-08) — 서버. 규칙은 answer-revise-spec.ts, 라우트는 `POST /api/messages/[id]/revise`.
//
// 순서: 답변·대화 주인 확인 → 고쳐 쓸 수 있는 답인지 → 이미 고쳐 쓴 답이면 그대로 돌려줌 → 한도 → 비서(쓸 수 있고 문서 찾기가 켜짐)
// → 고쳐 쓰는 중 표시로 차지(두 번 눌러도 모델은 한 번) → 같은 질문으로 대화와 같은 찾기 + 숫자가 든 문장으로 더 찾기
// → 모델 한 번(비서 지시문 + 참고 자료 + 더 찾은 근거 + 고쳐 쓰기 지시, 앞 질문·앞 답변·요청) → 사용 기록 → 숫자 확인 → 저장.
// 원래 답변 글은 고치지 않는다. 실패하면 차지를 풀어 다시 누를 수 있게 한다.
import type { LlmCompletion, LlmRequest, LlmUsage } from '@/lib/llm/types';
import type { RetrievedChunk } from '@/lib/db';
import { canUseAgent, type ActorScope, type AgentAccessInfo } from '@/lib/agent-permissions';
import { friendlyLlmMessage } from '@/lib/llm/errors';
import { buildSystemPrompt } from './prompt';
import { checkNumbers, numbersIn } from './number-check';
import { researchQueries, searchQueries } from './number-research';
import { toStoredChunk } from './persist';
import { MAX_OUTPUT_TOKENS } from './types';
import {
  REVISE_RULES, extraEvidence, extraEvidenceBlock, questionText, readRevision, reviseRequest, revisionEligibility, revisionPending,
  type RevisionView, type StoredRevision,
} from './answer-revise-spec';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const REVISE_NOT_FOUND = '고쳐 쓸 답변을 찾을 수 없습니다.';
export const REVISE_RETRY = '고쳐 쓰지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
export const REVISE_BUSY = '이 답변을 고쳐 쓰는 중입니다. 잠시 뒤 대화를 다시 열어 확인해 주세요.';
export const REVISE_DOCUMENTS_UNAVAILABLE = '참고 문서를 지금 불러오지 못했습니다 — 잠시 뒤 다시 시도해 주세요.';

export type ReviseAgent = AgentAccessInfo & { system_prompt: string | null; model_id: string | null; capabilities: unknown; agent_type: string | null };
type Refs = Record<string, unknown>;

export interface ReviseDeps {
  loadMessage(id: string): Promise<{ id: string; role: string; conversation_id: string; content: string; created_at: string; source_references: Refs | null } | null>;
  loadConversation(conversationId: string, userId: string): Promise<{ id: string; agent_id: string | null; department_id: string } | null>;
  /** 그 답변 바로 앞의 사용자 메시지(같은 대화, 시각이 같거나 앞) */
  loadQuestion(conversationId: string, atOrBefore: string): Promise<{ content: string; source_references: Refs | null } | null>;
  /**
   * 조건부 저장 — `expect`가 null이면 고쳐 쓰기 칸이 비었을 때만, 문자열이면 그 차지 시각일 때만 `source_references`를 `next`로 바꾼다.
   * 바꿨으면 true
   */
  writeRefs(messageId: string, next: Refs, expect: string | null): Promise<boolean>;
  checkLimit(departmentId: string, userId: string): Promise<{ allowed: true } | { allowed: false; message: string }>;
  loadAgent(agentId: string): Promise<ReviseAgent | null>;
  /** 기관 정책을 거친 비서 모델 */
  resolveModel(agent: ReviseAgent, organizationId: string): Promise<string>;
  /** 대화와 같은 찾기(근거 + 시스템 프롬프트에 붙을 글) — 실패면 null */
  prepare(agentId: string, organizationId: string, query: string): Promise<{ chunks: RetrievedChunk[]; systemAddendum?: string } | null>;
  /** 대화와 같은 찾기(근거만) — 숫자가 든 문장으로 더 찾을 때 */
  search(agentId: string, organizationId: string, query: string): Promise<RetrievedChunk[] | null>;
  complete(req: LlmRequest): Promise<LlmCompletion>;
  logUsage(usage: LlmUsage, row: { departmentId: string; userId: string; agentId: string; conversationId: string; messageId: string }): Promise<void>;
  logFailure(message: string, details: Record<string, unknown>): Promise<void>;
  now(): number;
}

type Failure = { ok: false; status: number; message: string };
export type ReviseResult = { ok: true; revision: RevisionView; reused: boolean; saved: boolean } | Failure;

const fail = (status: number, message: string): Failure => ({ ok: false, status, message });

export async function reviseAnswer(actor: ActorScope, messageId: string, deps: ReviseDeps): Promise<ReviseResult> {
  if (!actor.organizationId) return fail(403, '소속 기관을 확인할 수 없습니다.');
  const organizationId = actor.organizationId;
  if (!UUID.test(messageId)) return fail(404, REVISE_NOT_FOUND);
  const id = messageId.toLowerCase();

  const message = await deps.loadMessage(id);
  if (!message || message.role !== 'assistant') return fail(404, REVISE_NOT_FOUND);
  // 대화 주인만 — 관리자도 남의 답변을 고쳐 쓰지 못한다
  const conversation = await deps.loadConversation(message.conversation_id, actor.userId);
  if (!conversation || !conversation.agent_id) return fail(404, REVISE_NOT_FOUND);

  const refs: Refs = message.source_references && typeof message.source_references === 'object' ? { ...message.source_references } : {};
  const done = readRevision(refs.revision);
  if (done) return { ok: true, revision: done, reused: true, saved: true };
  if (revisionPending(refs.revision, deps.now())) return fail(409, REVISE_BUSY);

  const question = await deps.loadQuestion(conversation.id, message.created_at);
  const eligible = revisionEligibility(refs, question?.source_references);
  if (!eligible.ok) return fail(400, eligible.message);
  const query = question ? questionText(question.content) : '';
  if (!query) return fail(400, '이 답변의 질문을 찾지 못해 고쳐 쓸 수 없습니다.');

  const limit = await deps.checkLimit(actor.departmentId, actor.userId);
  if (!limit.allowed) return fail(429, limit.message);

  const agent = await deps.loadAgent(conversation.agent_id);
  if (!agent || agent.deleted_at || !agent.is_active) return fail(404, '이 답변의 비서를 찾을 수 없습니다.');
  if (!canUseAgent(agent, actor)) return fail(403, '이 비서를 쓸 권한이 없습니다.');
  const caps = agent.capabilities && typeof agent.capabilities === 'object' ? (agent.capabilities as Record<string, unknown>) : {};
  if (agent.agent_type === 'link' || !Object.prototype.hasOwnProperty.call(caps, 'doc_search')) return fail(400, '문서 찾기가 꺼진 비서라 고쳐 쓸 수 없습니다.');

  // 차지 — 칸이 비었거나(처음) 끊긴 고쳐 쓰기가 남긴 오래된 표시일 때만. 두 번 눌러도 모델은 한 번
  const previous = refs.revision as { status?: unknown; started_at?: unknown } | undefined;
  const expect = previous && previous.status === 'pending' && typeof previous.started_at === 'string' ? previous.started_at : null;
  const startedAt = new Date(deps.now()).toISOString();
  const base: Refs = { ...refs };
  delete base.revision;
  const claimed = await deps.writeRefs(id, { ...base, revision: { status: 'pending', started_at: startedAt } satisfies StoredRevision }, expect);
  if (!claimed) return fail(409, REVISE_BUSY);
  const release = () => deps.writeRefs(id, base, startedAt).catch(() => false);

  try {
    const prepared = await deps.prepare(agent.id, organizationId, query);
    if (!prepared) { await release(); return fail(503, REVISE_DOCUMENTS_UNAVAILABLE); }
    // 숫자가 든 문장으로 더 찾기 — 숫자 근거 다시 찾기와 같은 문장·같은 예산(문장 3개·5초)
    const found = await searchQueries(researchQueries(message.content, eligible.unverified), (q) => deps.search(agent.id, organizationId, q));
    const extras = extraEvidence(prepared.chunks, found);
    const system = buildSystemPrompt(agent.system_prompt, [prepared.systemAddendum, extraEvidenceBlock(extras), REVISE_RULES]);
    const model = await deps.resolveModel(agent, organizationId);

    let completion: LlmCompletion;
    try {
      completion = await deps.complete({
        model,
        system,
        messages: [
          { role: 'user', content: query },
          { role: 'assistant', content: message.content },
          { role: 'user', content: reviseRequest(eligible.unverified) },
        ],
        maxTokens: MAX_OUTPUT_TOKENS,
      });
    } catch (error) {
      await release();
      await deps.logFailure('근거로 고쳐 쓰기 — 모델 호출 실패', { agent_id: agent.id, message_id: id, error: error instanceof Error ? error.message.slice(0, 300) : 'unknown' }).catch(() => {});
      return fail(502, friendlyLlmMessage(error) ?? REVISE_RETRY);
    }
    // 토큰을 썼으면 글이 비어도 기록한다(과금 규약)
    await deps.logUsage(completion.usage, { departmentId: actor.departmentId, userId: actor.userId, agentId: agent.id, conversationId: conversation.id, messageId: id }).catch(() => {});
    const text = completion.text.trim();
    if (!text) { await release(); return fail(502, REVISE_RETRY); }

    // 대화의 숫자 확인과 같다 — 본 숫자 = 시스템 프롬프트(참고 자료·더 찾은 근거) + 질문. 요청 글의 숫자(확인해 달라는 숫자)와 앞 답변은 넣지 않는다
    const unverified = checkNumbers(text, numbersIn(system).concat(numbersIn(query)));
    const chunks = [...prepared.chunks, ...extras];
    const stored: StoredRevision = {
      status: 'done',
      started_at: startedAt,
      created_at: new Date(deps.now()).toISOString(),
      text,
      chunks: chunks.map(toStoredChunk),
      number_check: { unverified },
      revised_numbers: eligible.unverified,
      model: completion.usage.model,
    };
    const saved = await deps.writeRefs(id, { ...base, revision: stored }, startedAt).catch(() => false);
    if (!saved) {
      await deps.logFailure('근거로 고쳐 쓰기 — 고쳐 쓴 답을 저장하지 못함', { agent_id: agent.id, message_id: id }).catch(() => {});
    }
    const view = readRevision(JSON.parse(JSON.stringify(stored)));
    return { ok: true, revision: view!, reused: false, saved };
  } catch (error) {
    await release();
    await deps.logFailure('근거로 고쳐 쓰기 — 오류', { agent_id: agent.id, message_id: id, error: error instanceof Error ? error.message.slice(0, 300) : 'unknown' }).catch(() => {});
    return fail(500, REVISE_RETRY);
  }
}
