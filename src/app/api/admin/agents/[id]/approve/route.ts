import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { canApproveOfficial, type AgentVisibility } from '@/lib/agent-permissions';
import { loadAgentAccess, changeAgentTier } from '@/lib/agent-store';
import { jsonError } from '@/lib/agent-route-helpers';

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id || !isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('부서 정보를 찾을 수 없습니다.', 403);

    const agent = await loadAgentAccess(params.id);
    if (!agent || agent.deleted_at) return jsonError('비서를 찾을 수 없습니다.', 404);
    if (agent.approval_status !== 'pending') return jsonError('승인 대기 상태인 비서만 승인할 수 있습니다.', 409);

    const body = await request.json().catch(() => ({}));
    // 예전 화면은 scope: 'all' | 'department'로 보낸다
    const visibility: AgentVisibility =
      body.visibility === 'organization' || body.scope === 'all' ? 'organization' : 'department';

    if (!canApproveOfficial(agent, actor, visibility)) {
      return jsonError(
        visibility === 'organization'
          ? '기관 전체 공개 승인은 기관 전체를 관리하는 관리자만 할 수 있습니다.'
          : '이 부서의 비서를 승인할 권한이 없습니다.',
        403
      );
    }

    // 관리자가 검토한 판과 공식이 될 판이 같아야 한다
    if (agent.approval_version !== null && agent.approval_version !== agent.version) {
      return jsonError('신청 뒤 내용이 바뀌었습니다. 다시 확인해 주세요.', 409, {
        reason: 'changed_since_request',
        requestedVersion: agent.approval_version,
        currentVersion: agent.version,
      });
    }

    const result = await changeAgentTier({
      agentId: params.id,
      tier: 'official',
      actorId: actor.userId,
      departmentId: null, // 걸린 부서는 그대로
      visibility,
    });
    if (!result.ok) {
      if (result.reason === 'duplicate_name') return jsonError('같은 부서에 같은 이름의 비서가 이미 있습니다.', 409);
      return jsonError('승인 처리 중 오류가 발생했습니다.', 500);
    }

    return NextResponse.json({ ok: true, data: { id: params.id, tier: 'official', visibility } });
  } catch (error) {
    console.error('[admin approve POST]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}
