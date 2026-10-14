// src/app/api/agents/[id]/revert/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { canEditAgent } from '@/lib/agent-permissions';
import { loadAgentAccess, getVersionSnapshot, saveAgentSettings, saveFailureResponse } from '@/lib/agent-store';
import { SNAPSHOT_KEYS, type AgentSettingsPatch } from '@/lib/agent-patch';
import { jsonError, validateModelForOrganization, checkCapabilityScope } from '@/lib/agent-route-helpers';
import { normalizeCapabilities } from '@/lib/capabilities/settings';
import { connectorCatalog } from '@/lib/connectors';

/**
 * 옛 판으로 되돌린다. 옛 사본을 현재로 다시 쓰고 그것도 새 판으로 남긴다.
 *
 * 옛 판의 모델·능력이 지금 기관 규칙에 맞지 않을 수 있다(그 사이 기관이
 * 모델을 막았거나 연결을 껐다). 그대로 되살리면 규칙을 우회하는 길이
 * 되므로 저장할 때와 같은 검사를 다시 건다.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    const agent = await loadAgentAccess(params.id);
    if (!agent || agent.deleted_at) return jsonError('비서를 찾을 수 없습니다.', 404);
    if (!canEditAgent(agent, actor)) return jsonError('이 비서를 고칠 권한이 없습니다.', 403);

    const body = await request.json().catch(() => ({}));
    if (typeof body.version !== 'number' || typeof body.base_version !== 'number') {
      return jsonError('version과 base_version이 필요합니다.', 400);
    }
    if (body.version === agent.version) return jsonError('지금 판입니다.', 400);

    const snapshot = await getVersionSnapshot(params.id, body.version);
    if (!snapshot) return jsonError('그 판을 찾을 수 없습니다.', 404);

    const patch: AgentSettingsPatch = {};
    for (const key of SNAPSHOT_KEYS) {
      if (key in snapshot) (patch as Record<string, unknown>)[key] = snapshot[key];
    }

    const caps = normalizeCapabilities(patch.capabilities, { knownConnectorIds: connectorCatalog().map((c) => c.id) });
    if (!caps.ok) return jsonError(`그 판의 능력 설정을 지금 쓸 수 없습니다: ${caps.message}`, 400);
    patch.capabilities = caps.value;

    const modelError = await validateModelForOrganization(patch.model_id, actor.organizationId);
    if (modelError) return jsonError(`그 판의 모델을 지금 쓸 수 없습니다. ${modelError}`, 400);
    const scopeError = await checkCapabilityScope(agent.tier, patch.capabilities, actor.departmentId);
    if (scopeError) return jsonError(scopeError, 403);

    const saved = await saveAgentSettings(params.id, body.base_version, patch, actor.userId, 'revert', {
      reverted_from: body.version,
    });
    if (!saved.ok) {
      const failure = saveFailureResponse(saved);
      return jsonError(failure.message, failure.status, failure.details);
    }
    return NextResponse.json({ ok: true, data: { version: saved.version } });
  } catch (error) {
    console.error('[agent revert POST]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}
