import { NextRequest, NextResponse } from 'next/server';
import { BAD_BODY_MESSAGE, readJsonObject } from '@/lib/request-body';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getActorScope } from '@/lib/actor-scope';
import { canEditAgent, canDeleteAgent } from '@/lib/agent-permissions';
import { loadAgentAccess, saveAgentSettings, saveFailureResponse, softDeleteAgent } from '@/lib/agent-store';
import { splitAgentBody, changedSettingKeys, SNAPSHOT_KEYS } from '@/lib/agent-patch';
import type { AgentType } from '@/lib/agent-catalog';
import {
  jsonError,
  knownIds,
  validateModelForOrganization,
  checkCapabilityScope,
} from '@/lib/agent-route-helpers';

/**
 * 편집 창이 최신 판을 다시 읽는다. 고칠 수 있는 사람만 — 지시문 전문이 들어 있다.
 */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    const agent = await loadAgentAccess(params.id);
    if (!agent || agent.deleted_at) return jsonError('비서를 찾을 수 없습니다.', 404);
    if (!canEditAgent(agent, actor)) return jsonError('이 비서를 고칠 권한이 없습니다.', 403);

    // 위에서 있는 비서임을 확인했다 — 여기서 못 읽은 것은 '없음'이 아니다(2026-11-20, 예전엔 404 '비서를 찾을 수 없습니다')
    const { data, error } = await supabaseAdmin.from('agents').select('*').eq('id', params.id).maybeSingle();
    if (error) return jsonError('비서 설정을 지금 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
    if (!data) return jsonError('비서를 찾을 수 없습니다.', 404);
    // 함께 고치는 사람(0129)이 연 편집 창 — 주인이 아님을 알리고(공유 탭을 숨김) 공유 대상 목록은 싣지 않는다(2026-11-27 운영 확인에서 찾음:
    // 예전엔 공유 탭이 보여 눌러도 403 '불러오지 못했습니다'였고, 다른 공유 대상의 id가 함께 갔다)
    const row = data as Record<string, unknown>;
    if (row.tier === 'personal' && row.owner_id !== actor.userId) {
      const rest: Record<string, unknown> = { ...row, shared_with_me: true, shared_can_edit: true };
      delete rest.shared_user_ids; delete rest.shared_editor_ids; delete rest.shared_department_ids;
      return NextResponse.json({ ok: true, data: rest });
    }
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    console.error('[agents GET]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}

/**
 * 비서 고치기 — 세 단계 공통.
 *
 * 판 설정은 save_agent로(판이 남는다), 운영 값(노출·정렬·공개 범위·사용
 * 여부·유형)은 직접 바꾼다. 운영 값은 공식 비서에만 있다 — 나만의 비서는
 * 본인만 보고, 부서 비서는 공개 범위가 '부서'로 고정이다.
 */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다. 기관 관리자에게 문의하세요.', 403);

    const agent = await loadAgentAccess(params.id);
    if (!agent || agent.deleted_at) return jsonError('비서를 찾을 수 없습니다.', 404);
    if (!canEditAgent(agent, actor)) return jsonError('이 비서를 고칠 권한이 없습니다.', 403);

    const body = await readJsonObject(request);
    if (!body) return jsonError(BAD_BODY_MESSAGE, 400);

    const { data: current, error: currentError } = await supabaseAdmin
      .from('agents')
      .select(`agent_type, ${SNAPSHOT_KEYS.filter((k) => k !== 'template_ids').join(', ')}`)
      .eq('id', params.id)
      .single();
    // 지금 값을 못 읽으면 저장하지 않는다(2026-11-18 — 예전엔 빈 값으로 보고 유형을 'chat'으로·모든 설정을 '바뀜'으로 판정했다)
    if (currentError || !current) return jsonError('비서 설정을 지금 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
    const currentRow = current as unknown as Record<string, unknown>;

    const split = splitAgentBody(body, {
      currentType: ((currentRow.agent_type as AgentType) ?? 'chat'),
      ...knownIds(),
    });
    if (split.error) return jsonError(split.error, 400);

    // 검사는 전부 먼저 한다. 저장이 중간에 거절돼도 운영 값만 반영된 채
    // 남으면 안 된다(예: 판 충돌 409인데 노출은 이미 켜진 상태).
    const hasOperational = Object.keys(split.operational).length > 0;
    if (hasOperational) {
      if (agent.tier !== 'official') {
        return jsonError('노출·공개 범위·유형은 공식 비서에서만 바꿀 수 있습니다.', 400);
      }
      // 기관 전체로 넓히는 일은 기관 전체를 관리하는 관리자만 (canEditAgent와 같은 기준)
      if (
        split.operational.visibility === 'organization' &&
        agent.visibility !== 'organization' &&
        !(actor.isAdmin && actor.managesWholeOrganization)
      ) {
        return jsonError('기관 전체 공개는 기관 전체를 관리하는 관리자만 정할 수 있습니다.', 403);
      }
    }

    const changed = changedSettingKeys(currentRow, split.settings);
    let baseVersion = 0;
    if (changed.length > 0) {
      const modelError = await validateModelForOrganization(split.settings.model_id, actor.organizationId);
      if (modelError) return jsonError(modelError, 400);

      const scopeError = await checkCapabilityScope(agent.tier, split.settings.capabilities, actor.departmentId);
      if (scopeError) return jsonError(scopeError, 403);

      // 나만의 비서는 고치는 사람이 본인뿐이라 판 번호를 생략할 수 있다 — 함께 고치는 동료(0129)가 있으면 받는다.
      // 부서·공식 비서는 함께 고치므로 반드시 받는다.
      const rawBase = body.base_version;
      if (typeof rawBase === 'number') baseVersion = rawBase;
      else if (agent.tier === 'personal' && !(agent.shared_editor_ids ?? []).length) baseVersion = agent.version;
      else return jsonError('base_version이 필요합니다. 화면을 새로고침한 뒤 다시 시도해 주세요.', 400);
    }

    // ── 판 설정 (충돌할 수 있는 유일한 단계라 운영 값보다 먼저) ──
    if (changed.length > 0) {
      const onlyChanged = Object.fromEntries(
        changed.map((key) => [key, split.settings[key as keyof typeof split.settings]])
      );
      const saved = await saveAgentSettings(params.id, baseVersion, onlyChanged, actor.userId, 'settings');
      if (!saved.ok) {
        const failure = saveFailureResponse(saved);
        return jsonError(failure.message, failure.status, failure.details);
      }
    }

    // ── 운영 값 ──
    if (hasOperational) {
      const { error } = await supabaseAdmin
        .from('agents')
        .update({ ...split.operational, updated_by: actor.userId })
        .eq('id', params.id);
      if (error) return jsonError('비서 설정 변경 중 오류가 발생했습니다.', 500);
    }

    // 저장 뒤 다시 읽기를 못 하면 '성공·빈 값'이 아니라 그렇다고 알린다(2026-11-20 — 예전엔 화면이 빈 값으로 비서를 바꿔 목록이 깨졌다)
    const { data: agentRow, error: savedRowError } = await supabaseAdmin.from('agents').select('*').eq('id', params.id).single();
    if (savedRowError || !agentRow) return jsonError('저장했지만 바뀐 설정을 지금 다시 읽지 못했습니다. 화면을 새로 고쳐 확인해 주세요.', 503);
    return NextResponse.json({ ok: true, data: agentRow });
  } catch (error) {
    console.error('[agents PATCH]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다. 기관 관리자에게 문의하세요.', 403);

    const agent = await loadAgentAccess(params.id);
    if (!agent || agent.deleted_at) return jsonError('비서를 찾을 수 없습니다.', 404);
    if (!canDeleteAgent(agent, actor)) return jsonError('이 비서를 지울 권한이 없습니다.', 403);

    const done = await softDeleteAgent(params.id, actor.userId);
    if (!done) return jsonError('비서 삭제 중 오류가 발생했습니다.', 500);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[agents DELETE]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}
