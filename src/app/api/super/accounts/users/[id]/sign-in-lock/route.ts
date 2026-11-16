import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { unlockSignIn } from '@/lib/sign-in-throttle';
import { writeAuditRow } from '@/lib/audit-write';

export const dynamic = 'force-dynamic';

/**
 * 계정 로그인 잠금 풀기(2026-11-16, 슈퍼관리자) — 직원 로그인·슈퍼관리자 로그인 두 잠금(0091)을 함께 지운다.
 * 직원·슈퍼관리자 계정 모두 이 길로 푼다. IP 잠금은 풀지 않는다. `super_admin_logs`에 남긴다.
 */
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: { message: '인증 필요' } }, { status: 401 });

  try {
    const { data: target, error } = await supabaseAdmin
      .from('users')
      .select('id, email')
      .eq('id', params.id)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!target) return NextResponse.json({ ok: false, error: { message: '사용자를 찾을 수 없습니다.' } }, { status: 404 });

    await unlockSignIn('user', target.email);
    await unlockSignIn('super', target.email);

    try {
      await writeAuditRow('super_admin_logs', {
        admin_user_id: admin.sub,
        action: 'sign_in_unlocked',
        target_type: 'user',
        target_id: target.id,
      }, 'sign_in_unlocked');
    } catch { /* 감사 로그 실패는 무시 */ }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[super/accounts/users sign-in-lock DELETE]', err);
    return NextResponse.json({ ok: false, error: { message: '잠금을 풀지 못했습니다. 잠시 뒤 다시 시도해 주세요.' } }, { status: 500 });
  }
}
