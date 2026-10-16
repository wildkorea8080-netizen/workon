// src/lib/assistant/prepare.ts
import type { Session } from 'next-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getActorScope } from '@/lib/actor-scope';
import { canUseAgent, AGENT_ACCESS_COLUMNS, type AgentAccessInfo } from '@/lib/agent-permissions';
import { getCapabilityScope } from '@/lib/connector-scope';
import { checkTokenLimit, limitMessage } from '@/lib/usage-limit';
import { filterUserInput } from '@/lib/filter';
import { validateChatImages, type ChatImage } from '@/lib/chat-images';
import { getAllowedModelIds, resolveModel } from '@/lib/model-policy';
import { connectorCatalog } from '@/lib/connectors';
import { activeCapabilities, effectiveCapabilities, toolsFor } from '@/lib/capabilities';
import type { TurnContext, PrepareResult, TurnAttachment } from '@/lib/capabilities/types';
import {
  bindAttachments,
  checkAttachable,
  deleteConversationAttachments,
  listConversationAttachments,
  type AttachmentRecord,
} from '@/lib/attachments/store';
import { attachmentRequestError, toTurnAttachments } from './attachments';
import type { RetrievedChunk } from '@/lib/db';
import { buildSystemPrompt, buildUserContent, storedUserContent } from './prompt';
import { loadHistory } from './history';
import type { PrepareOutcome } from './types';

type AgentRow = AgentAccessInfo & {
  name: string;
  system_prompt: string | null;
  model_id: string | null;
  capabilities: unknown;
  agent_type: string | null;
};

function reject(message: string, status: number, details?: Record<string, unknown>): PrepareOutcome {
  return { ok: false, status, message, details };
}

/**
 * 첫 턴이 첨부 묶기에서 거절됐을 때 방금 만든 대화를 치운다. 일부만 묶였을 수 있어
 * 첨부 저장소를 먼저 지운다 — 행만 연쇄 삭제되면 객체가 남는다. 실패해도 던지지 않는다.
 */
async function discardNewConversation(conversationId: string, userId: string): Promise<void> {
  await deleteConversationAttachments(conversationId);
  const { error } = await supabaseAdmin.from('conversations').delete().eq('id', conversationId).eq('user_id', userId);
  if (error) console.error('[assistant] 거절된 첫 턴의 대화를 지우지 못함:', conversationId, error.message);
}

/**
 * 한 턴을 준비한다. 여기서 거절되면 라우트가 JSON으로 답한다
 * (스트림 시작 전 실패 규약).
 */
export async function prepareTurn(session: Session, body: Record<string, unknown>): Promise<PrepareOutcome> {
  const { agent_id, message, conversation_id, images, attachment_ids } = body;

  if (typeof agent_id !== 'string' || !agent_id) return reject('에이전트 ID는 필수입니다.', 400);
  if (typeof message !== 'string' || !message.trim()) return reject('메시지는 필수입니다.', 400);

  // 화면에서도 거르지만 그건 표시일 뿐이고 실제 제한은 여기서 건다.
  const imageError = validateChatImages(images);
  if (imageError) return reject(imageError, 400);
  const attachedImages: ChatImage[] = Array.isArray(images) ? (images as ChatImage[]) : [];

  // 소속을 알 수 없으면 거부한다. 추측해서 배정하면 타 기관 자료에 닿는다.
  const actor = await getActorScope(session);
  if (!actor || !actor.organizationId) {
    return reject('소속 부서가 지정되지 않았습니다. 기관 관리자에게 문의하세요.', 403);
  }

  // 사용자를 함께 넘긴다. 빠뜨리면 개인 한도가 조용히 적용되지 않는다.
  const limitStatus = await checkTokenLimit(actor.departmentId, actor.userId);
  if (!limitStatus.allowed) {
    return reject(limitMessage(limitStatus), 429, {
      reason: limitStatus.reason,
      usedTokens: limitStatus.usedTokens,
      limitTokens: limitStatus.limitTokens,
      budget: limitStatus.budget,
    });
  }

  const { data } = await supabaseAdmin
    .from('agents')
    .select(`${AGENT_ACCESS_COLUMNS}, name, system_prompt, model_id, capabilities, agent_type`)
    .eq('id', agent_id)
    .maybeSingle();
  const agent = data as AgentRow | null;

  if (!agent || agent.deleted_at || !agent.is_active) return reject('에이전트를 찾을 수 없습니다.', 404);
  if (!canUseAgent(agent, actor)) return reject('해당 에이전트에 접근할 권한이 없습니다.', 403);
  if (agent.agent_type === 'link') return reject('링크형 비서는 대화할 수 없습니다.', 400);

  const capabilitySettings = effectiveCapabilities(agent.capabilities, {
    tier: agent.tier,
    scope: agent.tier === 'official' ? { publicDataConnectors: new Set() } : await getCapabilityScope(actor.departmentId),
    knownConnectorIds: connectorCatalog().map((c) => c.id),
  });
  const capabilities = activeCapabilities(capabilitySettings);

  if (attachedImages.length > 0 && !capabilities.some((c) => c.acceptsImages)) {
    return reject('이 비서는 사진을 받지 않습니다. 사진 읽기를 켠 비서에서 물어 주세요.', 400);
  }

  // 대화를 만들기 전에 거른다 — 꺼진 비서에 파일을 보낸 요청으로 빈 대화가 생기지 않게
  const attachmentError = attachmentRequestError(attachment_ids, capabilities);
  if (attachmentError) return reject(attachmentError, 400);
  const sentIds: string[] = Array.isArray(attachment_ids) ? (attachment_ids as string[]) : [];

  const filterResult = await filterUserInput(actor.departmentId, message);
  if (!filterResult.isValid) {
    return reject('메시지에 금지된 내용이 포함되어 있습니다.', 400, {
      blockedWords: filterResult.blockedWords,
      blockedPatterns: filterResult.blockedPatterns,
    });
  }

  // ── 대화 ──
  const isNewConversation = !(typeof conversation_id === 'string' && conversation_id);
  let conversationId: string;
  let history: Awaited<ReturnType<typeof loadHistory>> = [];
  if (!isNewConversation) {
    const { data: existing } = await supabaseAdmin
      .from('conversations')
      .select('id')
      .eq('id', conversation_id)
      .eq('user_id', actor.userId)
      .eq('agent_id', agent_id)
      .maybeSingle();
    if (!existing) return reject('대화를 찾을 수 없습니다.', 404);
    conversationId = existing.id;
    if (sentIds.length > 0) {
      const check = await checkAttachable(actor.userId, sentIds, conversationId);
      if (!check.ok) return reject(check.message, 400);
    }
    history = await loadHistory(conversationId);
  } else {
    // 묶을 수 없는 첨부면 대화를 만들기 전에 돌려보낸다 — 거절될 요청으로 빈 대화가 남지 않게
    if (sentIds.length > 0) {
      const check = await checkAttachable(actor.userId, sentIds, null);
      if (!check.ok) return reject(check.message, 400);
    }
    const { data: created, error } = await supabaseAdmin
      .from('conversations')
      .insert({
        department_id: actor.departmentId,
        agent_id,
        user_id: actor.userId,
        title: `대화 with ${agent.name}`,
      })
      .select('id')
      .single();
    if (error || !created) {
      console.error('[assistant] conversation insert error:', error);
      return reject(`대화 생성 실패: ${error?.message ?? '알 수 없는 오류'}`, 500);
    }
    conversationId = created.id;
  }

  // ── 첨부 ── 대화가 정해진 뒤에 묶는다(새 대화면 방금 만든 id로). bindAttachments가 주인을 다시 본다
  let attachments: TurnAttachment[] = [];
  if (capabilities.some((c) => c.acceptsFiles)) {
    let bound: AttachmentRecord[] = [];
    let newlyBound: string[] = [];
    if (sentIds.length > 0) {
      const result = await bindAttachments(actor.userId, conversationId, sentIds);
      if (!result.ok) {
        // 확인과 묶기 사이에 바뀌었다. 방금 만든 대화면 지운다 — 대화 삭제 라우트와 같은 순서(첨부 저장소 → 행)
        if (isNewConversation) await discardNewConversation(conversationId, actor.userId);
        return reject(result.message, 400);
      }
      bound = result.rows;
      newlyBound = result.newlyBound;
    }
    // 새 대화에 보낸 것도 없으면 붙은 첨부가 있을 수 없다 — 조회를 아낀다
    const listed =
      !isNewConversation || bound.length > 0
        ? await listConversationAttachments(actor.userId, conversationId, {
            onError: (msg) =>
              console.warn('[assistant] 첨부 목록을 읽지 못해 이번 턴은 방금 묶은 첨부만으로 진행합니다:', conversationId, msg),
          })
        : [];
    // 목록 조회가 실패하면 빈 배열이 온다. 방금 묶은 것만은 빠지지 않게 채워 넣는다
    const missing = bound.filter((b) => !listed.some((r) => r.id === b.id));
    attachments = toTurnAttachments([...listed, ...missing], newlyBound);
  }

  // ── 모델 ── 기관 허용 범위 안이면 비서의 모델, 아니면 허용 목록의 첫 번째
  const allowedModels = await getAllowedModelIds(actor.organizationId);
  const { modelId, substituted } = resolveModel(agent.model_id, allowedModels);
  if (substituted) {
    console.warn('[assistant] 비서 모델이 기관 허용 목록 밖이라 바꿈:', agent.model_id, '→', modelId);
  }

  const ctx: TurnContext = {
    organizationId: actor.organizationId,
    departmentId: actor.departmentId,
    userId: actor.userId,
    agentId: agent_id,
    agentVersion: agent.version,
    capabilities: capabilitySettings,
    message,
    conversationId,
    attachments,
  };

  const prepared: PrepareResult[] = await Promise.all(
    capabilities.map((cap) => (cap.prepare ? cap.prepare(ctx) : Promise.resolve({} as PrepareResult)))
  );
  const chunks: RetrievedChunk[] = prepared.flatMap((p) => p.chunks ?? []);
  const { tools } = toolsFor(capabilities, ctx);

  return {
    ok: true,
    turn: {
      ctx,
      modelId,
      modelSubstituted: substituted,
      systemPrompt: buildSystemPrompt(agent.system_prompt, prepared.map((p) => p.systemAddendum)),
      messages: [...history, { role: 'user', content: buildUserContent(message, attachedImages) }],
      tools,
      capabilities,
      conversationId,
      isNewConversation,
      chunks,
      storedUserContent: storedUserContent(
        message,
        attachedImages.length,
        attachments.filter((a) => a.isNew).map((a) => a.fileName)
      ),
    },
  };
}
