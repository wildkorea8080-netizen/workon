import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getManagedDepartmentIds } from '@/lib/department-scope';
import { unlockSignIn } from '@/lib/sign-in-throttle';

export const dynamic = 'force-dynamic';

/**
 * 직원 로그인 잠금 풀기(2026-11-16) — 로그인을 30분 안에 5번 틀려 잠긴 계정(0091)의 실패 기록을 지운다.
 * 관리 범위(자기 부서 + 하위) 안의 직원만. IP 잠금은 풀지 않는다. 보안 로그에 남긴다(이메일 없이 대상 id만).
 */
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ ok: false, error: { message: '관리자 권한이 필요합니다.' } }, { status: 403 });
    }
    const adminDeptId = session.user.departmentId;
    if (!adminDeptId) {
      return NextResponse.json({ ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } }, { status: 403 });
    }
    const managedDeptIds = await getManagedDepartmentIds(adminDeptId);
    const { data: target, error } = await supabaseAdmin
      .from('users')
      .select('id, email, department_id')
      .eq('id', params.id)
      .eq('is_super_admin', false)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) {
      return NextResponse.json({ ok: false, error: { message: '직원 정보를 불러오지 못했습니다.' } }, { status: 500 });
    }
    if (!target || !target.department_id || !managedDeptIds.includes(target.department_id)) {
      return NextResponse.json({ ok: false, error: { message: '관리 권한이 없는 직원입니다.' } }, { status: 403 });
    }

    try {
      await unlockSignIn('user', target.email);
    } catch (e) {
      console.error('[users sign-in-lock DELETE]', e);
      return NextResponse.json({ ok: false, error: { message: '잠금을 풀지 못했습니다. 잠시 뒤 다시 시도해 주세요.' } }, { status: 500 });
    }

    try {
      await supabaseAdmin.from('security_logs').insert({
        department_id: adminDeptId,
        user_id: session.user.id,
        event_type: 'sign_in_unlocked',
        details: { target_user_id: target.id },
        severity: 'medium',
        created_at: new Date().toISOString(),
      });
    } catch { /* 보안 로그 실패는 풀기를 되돌리지 않는다 */ }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[users sign-in-lock DELETE] 오류:', err);
    return NextResponse.json({ ok: false, error: { message: '오류가 발생했습니다.' } }, { status: 500 });
  }
}
