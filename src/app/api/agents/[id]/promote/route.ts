import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { canPromoteToDepartment } from '@/lib/agent-permissions';
import { loadAgentAccess, changeAgentTier } from '@/lib/agent-store';
import { jsonError } from '@/lib/agent-route-helpers';

/**
 * 나만의 비서를 부서 비서로 올린다 — 사본을 만들지 않고 그 비서를 옮긴다(결정 1).
 * 주인 부서는 올리는 사람의 지금 부서다. 승인은 없다(결정 4).
 */
export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    const agent = await loadAgentAccess(params.id);
    if (!agent || agent.deleted_at) return jsonError('비서를 찾을 수 없습니다.', 404);
    if (!canPromoteToDepartment(agent, actor)) return jsonError('본인의 나만의 비서만 부서 비서로 올릴 수 있습니다.', 403);

    const result = await changeAgentTier({
      agentId: params.id,
      tier: 'department',
      actorId: actor.userId,
      departmentId: actor.departmentId,
      visibility: 'department',
    });
    if (!result.ok) {
      if (result.reason === 'duplicate_name') return jsonError('부서에 같은 이름의 비서가 이미 있습니다. 이름을 바꾼 뒤 다시 올려 주세요.', 409);
      if (result.reason === 'not_found') return jsonError('비서를 찾을 수 없습니다.', 404);
      return jsonError('부서 비서로 올리는 중 오류가 발생했습니다.', 500);
    }
    return NextResponse.json({ ok: true, data: { tier: 'department' } });
  } catch (error) {
    console.error('[agents promote]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}
