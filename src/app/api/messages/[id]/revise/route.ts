import { NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { AGENT_ACCESS_COLUMNS } from '@/lib/agent-permissions';
import { prepareLikeChat, searchLikeChat } from '@/lib/capabilities/doc-search';
import { complete } from '@/lib/llm';
import { getAllowedModelIds, resolveModel } from '@/lib/model-policy';
import { checkTokenLimit, limitMessage } from '@/lib/usage-limit';
import { logSystem } from '@/lib/logger';
import { buildUsageDetails, writeUsageLog } from '@/lib/assistant/persist';
import { reviseAnswer, type ReviseAgent, type ReviseDeps } from '@/lib/assistant/answer-revise';

// 찾기(재시도 창 10초) + 더 찾기(5초) + 모델 한 번(출력 상한까지) — 대화 라우트와 같은 상한
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/** 실제 DB·NODA·모델을 쓰는 의존 — 규칙은 `reviseAnswer`가 갖는다 */
function reviseDeps(organizationId: string): ReviseDeps {
  return {
    async loadMessage(id) {
      const { data, error } = await supabaseAdmin.from('messages').select('id, role, conversation_id, content, created_at, source_references').eq('id', id).maybeSingle();
      if (error) throw new Error(`messages: ${error.message}`);
      return data as Awaited<ReturnType<ReviseDeps['loadMessage']>>;
    },
    async loadConversation(conversationId, userId) {
      const { data, error } = await supabaseAdmin.from('conversations').select('id, agent_id, department_id').eq('id', conversationId).eq('user_id', userId).maybeSingle();
      if (error) throw new Error(`conversations: ${error.message}`);
      return data as Awaited<ReturnType<ReviseDeps['loadConversation']>>;
    },
    async loadQuestion(conversationId, atOrBefore) {
      // 한 턴의 두 행은 한 번에 들어가 시각이 같다 — 같거나 앞선 사용자 메시지 중 가장 늦은 것
      const { data, error } = await supabaseAdmin
        .from('messages')
        .select('content, source_references')
        .eq('conversation_id', conversationId)
        .eq('role', 'user')
        .lte('created_at', atOrBefore)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`messages: ${error.message}`);
      return data as Awaited<ReturnType<ReviseDeps['loadQuestion']>>;
    },
    async writeRefs(messageId, next, expect) {
      let update = supabaseAdmin.from('messages').update({ source_references: next }).eq('id', messageId).eq('role', 'assistant');
      update = expect === null ? update.is('source_references->revision', null) : update.eq('source_references->revision->>started_at', expect);
      const { data, error } = await update.select('id');
      if (error) throw new Error(`messages: ${error.message}`);
      return (data ?? []).length > 0;
    },
    async checkLimit(departmentId, userId) {
      const status = await checkTokenLimit(departmentId, userId);
      return status.allowed ? { allowed: true } : { allowed: false, message: limitMessage(status) };
    },
    async loadAgent(agentId) {
      const { data, error } = await supabaseAdmin
        .from('agents')
        .select(`${AGENT_ACCESS_COLUMNS}, system_prompt, model_id, capabilities, agent_type`)
        .eq('id', agentId)
        .maybeSingle();
      if (error) throw new Error(`agents: ${error.message}`);
      return data as ReviseAgent | null;
    },
    async resolveModel(agent, orgId) {
      return resolveModel(agent.model_id, await getAllowedModelIds(orgId)).modelId;
    },
    prepare: (agentId, orgId, query) => prepareLikeChat({ agentId, organizationId: orgId, query }),
    search: (agentId, orgId, query) => searchLikeChat({ agentId, organizationId: orgId, query }),
    complete,
    logUsage: (usage, row) => writeUsageLog({
      departmentId: row.departmentId, userId: row.userId, action: 'answer_revised', resourceType: 'agent', resourceId: row.agentId,
      details: buildUsageDetails(usage, { agent_id: row.agentId, conversation_id: row.conversationId, message_id: row.messageId }),
    }),
    logFailure: (message, details) => logSystem({ level: 'warning', category: 'api', message, details, orgId: organizationId }),
    now: () => Date.now(),
  };
}

/**
 * 근거로 고쳐 쓰기(2026-11-08) — 숫자 확인이 확인되지 않은 숫자를 남긴 문서 근거 답변을, 다시 찾은 근거로 한 번 고쳐 쓴다.
 * 대화 주인만. 원래 답변은 그대로 두고 고쳐 쓴 답은 `source_references.revision`에. 이미 고쳐 쓴 답이면 모델을 부르지 않고 그것을 돌려준다.
 * 사용 기록 `answer_revised`(모델·토큰·원가)
 */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);
  const actor = await getActorScope(session);
  if (!actor?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);
  try {
    const result = await reviseAnswer(actor, params.id, reviseDeps(actor.organizationId));
    if (!result.ok) return jsonError(result.message, result.status);
    return NextResponse.json({ ok: true, data: { revision: result.revision, reused: result.reused, saved: result.saved } });
  } catch (error) {
    console.error('[messages/revise]', error);
    return jsonError('고쳐 쓰지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 500);
  }
}
