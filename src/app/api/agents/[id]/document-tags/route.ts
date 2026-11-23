import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { actorScopeOr503 } from '@/lib/actor-scope-response';
import { canUseAgent } from '@/lib/agent-permissions';
import { isAgentReadError, loadAgentAccess } from '@/lib/agent-store';
import { agentDocumentTags } from '@/lib/agent-document-tags';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * 대화의 '문서 좁히기'(2026-11-23)가 보일 태그 — 이 비서가 근거로 쓰는 문서에 붙은 태그와 문서 수(문서 이름은 싣지 않는다).
 * 그 비서를 지금 쓸 수 있는 사람만(대화와 같은 `canUseAgent`). 없는 비서·쓸 수 없는 비서는 똑같이 404, 못 읽으면 503.
 */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);
  const actor = await actorScopeOr503(session);
  if (actor instanceof Response) return actor;
  if (!actor) return jsonError('소속 부서가 지정되지 않았습니다.', 403);
  try {
    const agent = await loadAgentAccess(params.id);
    if (!agent || agent.deleted_at || !canUseAgent(agent, actor)) return jsonError('비서를 찾을 수 없습니다.', 404);
    const tags = await agentDocumentTags(params.id);
    return NextResponse.json({ ok: true, data: { tags } });
  } catch (error) {
    if (!isAgentReadError(error)) console.error('[agent document-tags GET]', error instanceof Error ? error.message : error);
    return jsonError('문서 태그를 지금 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  }
}
