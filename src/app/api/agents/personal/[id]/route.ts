import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { canEditAgent, canDeleteAgent } from '@/lib/agent-permissions';
import { loadAgentAccess, saveAgentSettings, saveFailureResponse, softDeleteAgent } from '@/lib/agent-store';
import { splitAgentBody, changedSettingKeys, SNAPSHOT_KEYS } from '@/lib/agent-patch';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { jsonError, knownIds, validateModelForOrganization, checkCapabilityScope } from '@/lib/agent-route-helpers';

/** 옛 주소. 판정과 저장은 /api/agents/[id]와 같은 모듈을 거친다. */
export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    const agent = await loadAgentAccess(params.id);
    if (!agent || agent.deleted_at || agent.tier !== 'personal') return jsonError('비서를 찾을 수 없습니다.', 404);
    if (!canEditAgent(agent, actor)) return jsonError('본인의 비서만 수정할 수 있습니다.', 403);

    const { systemPrompt, base_version, ...rest } = (await request.json()) as Record<string, unknown>;
    const split = splitAgentBody(
      { ...rest, ...(systemPrompt !== undefined ? { system_prompt: systemPrompt } : {}) },
      { currentType: 'chat', ...knownIds() }
    );
    if (split.error) return jsonError(split.error, 400);
    if (Object.keys(split.operational).length > 0) {
      return jsonError('노출·공개 범위·유형은 공식 비서에서만 바꿀 수 있습니다.', 400);
    }

    // 옛 화면은 바꾸지 않은 칸까지 전부 보낸다. 그대로 저장하면 매번 빈 판이
    // 쌓이고, 바뀐 칸 기록(fields)도 실제 변경과 어긋난다. /api/agents/[id]와 같은 규칙.
    const { data: current } = await supabaseAdmin
      .from('agents')
      .select(SNAPSHOT_KEYS.filter((k) => k !== 'template_ids').join(', '))
      .eq('id', params.id)
      .single();
    const changed = changedSettingKeys((current ?? {}) as unknown as Record<string, unknown>, split.settings);
    if (changed.length === 0) return NextResponse.json({ ok: true, data: { version: agent.version } });

    const modelError = await validateModelForOrganization(split.settings.model_id, actor.organizationId);
    if (modelError) return jsonError(modelError, 400);
    const scopeError = await checkCapabilityScope('personal', split.settings.capabilities, actor.departmentId);
    if (scopeError) return jsonError(scopeError, 403);

    const onlyChanged = Object.fromEntries(
      changed.map((key) => [key, split.settings[key as keyof typeof split.settings]])
    );
    const saved = await saveAgentSettings(
      params.id,
      typeof base_version === 'number' ? base_version : agent.version,
      onlyChanged,
      actor.userId,
      'settings'
    );
    if (!saved.ok) {
      const failure = saveFailureResponse(saved);
      return jsonError(failure.message, failure.status, failure.details);
    }
    return NextResponse.json({ ok: true, data: { version: saved.version } });
  } catch (error) {
    console.error('[personal agent PUT]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    const agent = await loadAgentAccess(params.id);
    if (!agent || agent.deleted_at || agent.tier !== 'personal') return jsonError('비서를 찾을 수 없습니다.', 404);
    if (!canDeleteAgent(agent, actor)) return jsonError('본인의 비서만 삭제할 수 있습니다.', 403);

    const done = await softDeleteAgent(params.id, actor.userId);
    if (!done) return jsonError('비서 삭제 중 오류가 발생했습니다.', 500);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[personal agent DELETE]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}
