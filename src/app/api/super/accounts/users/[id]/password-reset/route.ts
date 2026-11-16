import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { passwordResetDeps, resetUserPassword } from '@/lib/password-reset';
import { sendPasswordResetEmail } from '@/lib/mailer';
import { APP_URL } from '@/lib/config';
import { writeAuditRow } from '@/lib/audit-write';

export const dynamic = 'force-dynamic';

/**
 * 직원 임시 비밀번호 재발급(2026-11-16, 슈퍼관리자) — 기관 관리자 재발급과 같은 `resetUserPassword`.
 * 직원 계정만(슈퍼관리자 계정은 본인 '비밀번호 변경'), 비활성·탈퇴 계정은 막는다. 직원은 다음 로그인에 비밀번호부터 바꾼다(0093).
 * 새 비밀번호는 응답과 안내 메일에 한 번만. `super_admin_logs`에 남긴다(비밀번호 없음).
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: { message: '인증 필요' } }, { status: 401 });

  try {
    const { data: target, error } = await supabaseAdmin
      .from('users')
      .select('id, email, full_name, is_active')
      .eq('id', params.id)
      .eq('is_super_admin', false)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!target) return NextResponse.json({ ok: false, error: { message: '사용자를 찾을 수 없습니다.' } }, { status: 404 });
    if (target.is_active === false) {
      return NextResponse.json({ ok: false, error: { message: '비활성 계정입니다. 먼저 활성화해 주세요.' } }, { status: 400 });
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

    try {
      await writeAuditRow('super_admin_logs', {
        admin_user_id: admin.sub,
        action: 'password_reset',
        target_type: 'user',
        target_id: target.id,
        after_data: { email_sent: mail.sent, sessions_kept: result.sessionsKept },
      }, 'password_reset');
    } catch { /* 감사 로그 실패는 무시 */ }

    return NextResponse.json({ ok: true, data: { tempPassword: result.tempPassword, emailSent: mail.sent } });
  } catch (err) {
    console.error('[super/accounts/users password-reset POST]', err);
    return NextResponse.json({ ok: false, error: { message: '비밀번호를 재발급하지 못했습니다.' } }, { status: 500 });
  }
}
