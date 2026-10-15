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
import type { TurnContext, PrepareResult } from '@/lib/capabilities/types';
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
 * 한 턴을 준비한다. 여기서 거절되면 라우트가 JSON으로 답한다
 * (스트림 시작 전 실패 규약).
 */
export async function prepareTurn(session: Session, body: Record<string, unknown>): Promise<PrepareOutcome> {
  const { agent_id, message, conversation_id, images } = body;

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

  const filterResult = await filterUserInput(actor.departmentId, message);
  if (!filterResult.isValid) {
    return reject('메시지에 금지된 내용이 포함되어 있습니다.', 400, {
      blockedWords: filterResult.blockedWords,
      blockedPatterns: filterResult.blockedPatterns,
    });
  }

  // ── 대화 ──
  let conversationId: string;
  let history: Awaited<ReturnType<typeof loadHistory>> = [];
  if (typeof conversation_id === 'string' && conversation_id) {
    const { data: existing } = await supabaseAdmin
      .from('conversations')
      .select('id')
      .eq('id', conversation_id)
      .eq('user_id', actor.userId)
      .eq('agent_id', agent_id)
      .maybeSingle();
    if (!existing) return reject('대화를 찾을 수 없습니다.', 404);
    conversationId = existing.id;
    history = await loadHistory(conversationId);
  } else {
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
      isNewConversation: !(typeof conversation_id === 'string' && conversation_id),
      chunks,
      storedUserContent: storedUserContent(message, attachedImages.length),
    },
  };
}
