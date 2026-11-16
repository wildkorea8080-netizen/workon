import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getManagedDepartmentIds } from '@/lib/department-scope';

export const dynamic = 'force-dynamic';

/**
 * 직원 계정 사용 중지·다시 사용(2026-11-16, 기관 관리자). 예전엔 슈퍼관리자만 계정을 끌 수 있어, 퇴직·전출한 직원의 계정을
 * 기관이 직접 막지 못했다. 관리 범위 직원만, 본인은 안 됨, 대리 접근 중 막음. 끄면 로그인이 막히고(`canSignIn`)
 * 이미 열린 로그인은 미들웨어가 30초 안에 끝낸다(`userSessionVerdict`). 탈퇴(행·기록 정리)는 여전히 슈퍼관리자 '계정 삭제'.
 * 보안 로그 high(대상 id·사유).
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ ok: false, error: { message: '관리자 권한이 필요합니다.' } }, { status: 403 });
    }
    if (session.user.isImpersonating) {
      return NextResponse.json({ ok: false, error: { message: '대리 접근 중에는 계정을 끄거나 켤 수 없습니다.' } }, { status: 403 });
    }
    if (params.id === session.user.id) {
      return NextResponse.json({ ok: false, error: { message: '본인 계정은 끌 수 없습니다.' } }, { status: 400 });
    }
    let body: { active?: unknown; reason?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ ok: false, error: { message: '요청 형식이 올바르지 않습니다.' } }, { status: 400 });
    }
    if (typeof body.active !== 'boolean') {
      return NextResponse.json({ ok: false, error: { message: '켤지 끌지를 정해 주세요.' } }, { status: 400 });
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '';
    if (!body.active && reason.length < 2) {
      return NextResponse.json({ ok: false, error: { message: '사용 중지 사유를 적어 주세요(예: 퇴직, 전출).' } }, { status: 400 });
    }

    const adminDeptId = session.user.departmentId;
    if (!adminDeptId) {
      return NextResponse.json({ ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } }, { status: 403 });
    }
    const managedDeptIds = await getManagedDepartmentIds(adminDeptId);
    const { data: target, error } = await supabaseAdmin
      .from('users')
      .select('id, department_id, is_active')
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

    const { data: updated, error: updateError } = await supabaseAdmin
      .from('users')
      .update({ is_active: body.active })
      .eq('id', target.id)
      .is('deleted_at', null)
      .select('id, is_active')
      .maybeSingle();
    if (updateError || !updated) {
      return NextResponse.json({ ok: false, error: { message: '계정 상태를 바꾸지 못했습니다.' } }, { status: 500 });
    }

    try {
      await supabaseAdmin.from('security_logs').insert({
        department_id: adminDeptId,
        user_id: session.user.id,
        event_type: body.active ? 'user_reactivated' : 'user_deactivated',
        details: { target_user_id: target.id, reason: reason || null },
        severity: 'high',
        created_at: new Date().toISOString(),
      });
    } catch { /* 보안 로그 실패는 되돌리지 않는다 */ }

    return NextResponse.json({ ok: true, data: { id: updated.id, is_active: updated.is_active } });
  } catch (err) {
    console.error('[users active POST]', err);
    return NextResponse.json({ ok: false, error: { message: '오류가 발생했습니다.' } }, { status: 500 });
  }
}
