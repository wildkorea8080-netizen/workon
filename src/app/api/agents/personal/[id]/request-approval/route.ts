import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getActorScope } from '@/lib/actor-scope';
import { canRequestOfficial } from '@/lib/agent-permissions';
import { loadAgentAccess } from '@/lib/agent-store';
import { jsonError } from '@/lib/agent-route-helpers';

/**
 * 공식 등록 신청 — 나만의 비서와 부서 비서 모두.
 *
 * 신청 시점의 판 번호를 남긴다. 부서 비서는 신청 중에도 부서원이 고칠 수
 * 있어서, 관리자가 검토한 판과 실제로 공식이 되는 판이 달라질 수 있다.
 * 승인할 때 이 번호와 지금 판을 비교한다.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    const agent = await loadAgentAccess(params.id);
    if (!agent || agent.deleted_at) return jsonError('비서를 찾을 수 없습니다.', 404);
    if (agent.approval_status === 'pending') return jsonError('이미 승인 신청 중입니다.', 409);
    if (agent.tier === 'official') return jsonError('이미 공식 비서입니다.', 409);
    if (!canRequestOfficial(agent, actor)) return jsonError('이 비서를 신청할 권한이 없습니다.', 403);

    const body = await request.json().catch(() => ({}));
    const note: string | null = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;

    const { error } = await supabaseAdmin
      .from('agents')
      .update({
        approval_status: 'pending',
        approval_note: note,
        approval_version: agent.version,
        approval_requested_by: actor.userId,
      })
      .eq('id', params.id);

    if (error) return jsonError('승인 신청 중 오류가 발생했습니다.', 500);

    return NextResponse.json({ ok: true, data: { success: true, message: '관리자에게 신청됐습니다.' } });
  } catch (error) {
    console.error('[request-approval POST]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}
