import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getActorScope } from '@/lib/actor-scope';

export async function GET(request: NextRequest) {
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

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status') ?? 'pending';

    const { data: agents, error } = await supabaseAdmin
      .from('agents')
      .select(`
        *,
        owner:users!owner_id ( id, email, full_name ),
        requester:users!approval_requested_by ( id, email, full_name )
      `)
      .in('department_id', actor.managedDepartmentIds)
      .eq('approval_status', status)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json(
        { ok: false, error: { message: '승인 대기 목록 조회 중 오류가 발생했습니다.' } },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, data: agents });
  } catch (error) {
    console.error('[admin approvals GET]', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
