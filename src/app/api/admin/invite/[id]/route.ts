import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getManagedDepartmentIds } from '@/lib/department-scope';
import { logSecurityEvent } from '@/lib/security-log';

export const dynamic = 'force-dynamic';

/**
 * 초대 취소 — **아직 수락하지 않은 초대만** 지운다(2026-11-18). 예전에는 수락된 초대도 지워져 '누가 누구를 어떤 권한으로 초대했는지'의
 * 마지막 흔적이 사라졌고, 지운 것이 없어도(남의 부서·없는 초대) 성공으로 답했다. 관리 범위의 초대만, 취소는 보안 로그에(`user_invite_canceled`).
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
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

    const managed = await getManagedDepartmentIds(departmentId);

    const { data: removed, error } = await supabaseAdmin
      .from('invitations')
      .delete()
      .eq('id', params.id)
      .in('department_id', managed)
      .is('accepted_at', null)
      .select('id, email, role');

    if (error) {
      return NextResponse.json(
        { ok: false, error: { message: '초대 취소에 실패했습니다.' } },
        { status: 500 }
      );
    }

    const row = ((removed ?? []) as Array<{ id: string; email: string; role: string }>)[0];
    if (!row) {
      return NextResponse.json(
        { ok: false, error: { message: '취소할 초대를 찾을 수 없습니다. 이미 수락됐거나 취소된 초대입니다.' } },
        { status: 404 }
      );
    }

    await logSecurityEvent(
      departmentId,
      session.user.id,
      'user_invite_canceled',
      {
        invitation_id: row.id,
        invited_email: row.email,
        invited_role: row.role,
        ...(session.user.isImpersonating ? { impersonating: true } : {}),
      },
      'low'
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[invite DELETE] 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
