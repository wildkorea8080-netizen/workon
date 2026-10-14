// src/app/api/agents/[id]/history/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { canEditAgent } from '@/lib/agent-permissions';
import { loadAgentAccess, getAgentHistory } from '@/lib/agent-store';
import { jsonError } from '@/lib/agent-route-helpers';

/** 변경 기록은 그 비서를 고칠 수 있는 사람이 본다. 지시문 전문이 들어 있다. */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    const agent = await loadAgentAccess(params.id);
    if (!agent || agent.deleted_at) return jsonError('비서를 찾을 수 없습니다.', 404);
    if (!canEditAgent(agent, actor)) return jsonError('변경 기록을 볼 권한이 없습니다.', 403);

    const items = await getAgentHistory(params.id);
    return NextResponse.json({ ok: true, data: { version: agent.version, items } });
  } catch (error) {
    console.error('[agent history GET]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}
