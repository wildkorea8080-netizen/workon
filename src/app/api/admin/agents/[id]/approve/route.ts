import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json(
        { ok: false, error: { message: '관리자 권한이 필요합니다.' } },
        { status: 403 }
      );
    }

    const departmentId = session.user.departmentId;
    if (!departmentId) {
      return NextResponse.json(
        { ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } },
        { status: 403 }
      );
    }

    const { data: existing, error: fetchError } = await supabaseAdmin
      .from('agents')
      .select('id, approval_status')
      .eq('id', params.id)
      .eq('department_id', departmentId)
      .maybeSingle();

    if (fetchError || !existing) {
      return NextResponse.json(
        { ok: false, error: { message: '비서를 찾을 수 없습니다.' } },
        { status: 404 }
      );
    }

    if (existing.approval_status !== 'pending') {
      return NextResponse.json(
        { ok: false, error: { message: '승인 대기 상태인 비서만 승인할 수 있습니다.' } },
        { status: 409 }
      );
    }

    // scope: 'department'(기본) | 'all' — 향후 확장용, 현재는 department_id 유지
    const body = await request.json().catch(() => ({}));
    const scope: string = body.scope ?? 'department';

    const { data: agent, error } = await supabaseAdmin
      .from('agents')
      .update({
        is_personal: false,
        owner_id: null,
        approval_status: 'approved',
        approval_note: scope,   // scope 정보를 note에 보존
        updated_by: session.user.id,
      })
      .eq('id', params.id)
      .select()
      .single();

    if (error) {
      return NextResponse.json(
        { ok: false, error: { message: '승인 처리 중 오류가 발생했습니다.' } },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, data: agent });
  } catch (error) {
    console.error('[admin approve POST]', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
