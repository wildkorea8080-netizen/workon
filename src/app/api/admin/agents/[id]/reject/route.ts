import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getActorScope } from '@/lib/actor-scope';
import { canApproveOfficial } from '@/lib/agent-permissions';
import { loadAgentAccess, recordAgentEvent } from '@/lib/agent-store';

/** 반려 사유 상한 — 신청 메모와 같다. 신청한 직원의 화면과 변경 기록에 그대로 보인다 */
const MAX_NOTE = 500;

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json(
        { ok: false, error: { message: '관리자 권한이 필요합니다.' } },
        { status: 403 }
      );
    }

    const actor = await getActorScope(session);
    if (!actor) {
      return NextResponse.json({ ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } }, { status: 403 });
    }

    const body = (await request.json().catch(() => null)) as { note?: unknown } | null;
    const note = typeof body?.note === 'string' ? body.note.trim().slice(0, MAX_NOTE) : '';

    if (!note) {
      return NextResponse.json(
        { ok: false, error: { message: '반려 사유는 필수입니다.' } },
        { status: 400 }
      );
    }

    const agent = await loadAgentAccess(params.id);
    if (!agent || agent.deleted_at) {
      return NextResponse.json({ ok: false, error: { message: '비서를 찾을 수 없습니다.' } }, { status: 404 });
    }

    // 반려도 승인과 같은 사람이 한다 — 부서 범위로 판정한다
    if (!canApproveOfficial(agent, actor, 'department')) {
      return NextResponse.json({ ok: false, error: { message: '이 부서의 비서를 반려할 권한이 없습니다.' } }, { status: 403 });
    }

    if (agent.approval_status !== 'pending') {
      return NextResponse.json(
        { ok: false, error: { message: '승인 대기 상태인 비서만 반려할 수 있습니다.' } },
        { status: 409 }
      );
    }

    // **아직 승인 대기일 때만** 반려로 바꾼다(2026-11-18). 예전에는 조건이 없어, 위에서 대기 상태를 본 뒤 다른 관리자가 승인하면
    // 이미 공식이 된 비서의 상태를 '반려'로 덮었다. 응답에는 필요한 칸만(예전엔 행 전체 — 지시문까지 — 를 돌려줬다)
    const { data: rejectedRows, error } = await supabaseAdmin
      .from('agents')
      .update({
        approval_status: 'rejected',
        approval_note: note,
        approval_version: null,
        updated_by: session.user.id,
      })
      .eq('id', params.id)
      .eq('approval_status', 'pending')
      .is('deleted_at', null)
      .select('id, approval_status, approval_note');

    if (error) {
      return NextResponse.json(
        { ok: false, error: { message: '반려 처리 중 오류가 발생했습니다.' } },
        { status: 500 }
      );
    }

    const rejected = ((rejectedRows ?? []) as Array<{ id: string; approval_status: string; approval_note: string | null }>)[0];
    if (!rejected) {
      return NextResponse.json(
        { ok: false, error: { message: '그 사이 다른 관리자가 처리했습니다. 목록을 새로 고쳐 주세요.' } },
        { status: 409 }
      );
    }

    // 누가 언제 왜 반려했는지를 변경 기록에 — 반려 사유 칸은 다시 신청하면 덮인다
    await recordAgentEvent(params.id, 'tier', session.user.id, {
      event: 'official_rejected',
      note,
      ...(agent.approval_version !== null ? { requested_version: agent.approval_version } : {}),
    });

    return NextResponse.json({ ok: true, data: rejected });
  } catch (error) {
    console.error('[admin reject POST]', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
