import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getActorScope } from '@/lib/actor-scope';
import { canRequestOfficial } from '@/lib/agent-permissions';
import { loadAgentAccess, recordAgentEvent } from '@/lib/agent-store';
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
    // 메모는 관리자 승인 화면에 그대로 보인다 — 500자에서 자른다
    const note: string | null = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null;

    const { data: requested, error } = await supabaseAdmin
      .from('agents')
      .update({
        approval_status: 'pending',
        approval_note: note,
        approval_version: agent.version,
        approval_requested_by: actor.userId,
      })
      .eq('id', params.id)
      .is('deleted_at', null)
      .select('id');

    if (error) return jsonError('승인 신청 중 오류가 발생했습니다.', 500);
    // 그 사이 지워졌으면 신청된 것이 없다 — 성공으로 답하지 않는다
    if (((requested ?? []) as unknown[]).length === 0) return jsonError('비서를 찾을 수 없습니다.', 404);

    // 누가 언제 어느 판을 신청했는지를 변경 기록에(2026-11-18) — 신청 메모는 반려하면 사유로 덮인다
    await recordAgentEvent(params.id, 'tier', actor.userId, {
      event: 'official_requested',
      requested_version: agent.version,
      ...(note ? { note } : {}),
    });

    return NextResponse.json({ ok: true, data: { success: true, message: '관리자에게 신청됐습니다.' } });
  } catch (error) {
    console.error('[request-approval POST]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}
