import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getManagedDepartmentIds } from '@/lib/department-scope';
import { passwordResetDeps, resetUserPassword } from '@/lib/password-reset';
import { sendPasswordResetEmail } from '@/lib/mailer';
import { APP_URL } from '@/lib/config';
import { logSecurityEvent } from '@/lib/security-log';

export const dynamic = 'force-dynamic';

/**
 * 직원 임시 비밀번호 재발급(2026-11-16, `src/lib/password-reset.ts`). 관리 범위 직원만, 본인은 '비밀번호 바꾸기'로.
 * 대리 접근 중에는 막는다. 새 임시 비밀번호는 응답과 안내 메일(설정돼 있으면)에 한 번만 — 어디에도 저장하지 않는다.
 * 그 직원의 모든 로그인이 끝나고 로그인 실패 잠금이 풀린다. 보안 로그 high(대상 id만, 비밀번호 없음).
 */
export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ ok: false, error: { message: '관리자 권한이 필요합니다.' } }, { status: 403 });
    }
    if (session.user.isImpersonating) {
      return NextResponse.json({ ok: false, error: { message: '대리 접근 중에는 비밀번호를 재발급할 수 없습니다.' } }, { status: 403 });
    }
    if (params.id === session.user.id) {
      return NextResponse.json({ ok: false, error: { message: '본인 비밀번호는 사용자 메뉴의 \'비밀번호·로그인 기록\'에서 바꿔 주세요.' } }, { status: 400 });
    }
    const adminDeptId = session.user.departmentId;
    if (!adminDeptId) {
      return NextResponse.json({ ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } }, { status: 403 });
    }
    const managedDeptIds = await getManagedDepartmentIds(adminDeptId);
    const { data: target, error } = await supabaseAdmin
      .from('users')
      .select('id, email, full_name, department_id, is_active')
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
    if (target.is_active === false) {
      return NextResponse.json({ ok: false, error: { message: '비활성 계정입니다. 먼저 계정을 활성화해 주세요.' } }, { status: 400 });
    }

    const result = await resetUserPassword(passwordResetDeps(), { id: target.id, email: target.email });
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: { message: '비밀번호를 재발급하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' } }, { status: 500 });
    }

    const mail = await sendPasswordResetEmail({
      to: target.email,
      fullName: target.full_name || target.email,
      tempPassword: result.tempPassword,
      loginUrl: `${APP_URL}/login`,
    }).catch(() => ({ sent: false }));

    // 보안 로그 실패는 재발급을 되돌리지 않는다(실패는 운영 기록에 남는다)
    await logSecurityEvent(adminDeptId, session.user.id, 'password_reset_by_admin', { target_user_id: target.id, email_sent: mail.sent, sessions_kept: result.sessionsKept }, 'high');

    return NextResponse.json({ ok: true, data: { tempPassword: result.tempPassword, emailSent: mail.sent } });
  } catch (err) {
    console.error('[users password-reset POST]', err);
    return NextResponse.json({ ok: false, error: { message: '오류가 발생했습니다.' } }, { status: 500 });
  }
}
