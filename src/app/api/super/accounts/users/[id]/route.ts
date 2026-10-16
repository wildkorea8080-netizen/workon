import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withdrawUser } from '@/lib/user-withdrawal';

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  try {
    const body = await request.json();
    const update: Record<string, unknown> = {};

    if (body.isActive !== undefined) update.is_active = body.isActive;
    if (body.role !== undefined) {
      if (!['ADMIN', 'USER'].includes(body.role))
        return NextResponse.json({ ok: false, error: '유효하지 않은 role' }, { status: 400 });
      update.role = body.role;
    }

    const { data, error } = await supabaseAdmin
      .from('users')
      .update(update)
      .eq('id', params.id)
      .is('deleted_at', null) // 삭제(탈퇴)한 계정을 다시 켜지 못하게
      .select('id, email, full_name, role')
      .maybeSingle();

    if (error) {
      // is_active 컬럼 없을 때 안내
      if (error.message?.includes('is_active')) {
        return NextResponse.json({
          ok: false,
          error: 'DB에 is_active 컬럼이 없습니다. Supabase SQL Editor에서 실행:\nALTER TABLE users ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;',
        }, { status: 500 });
      }
      throw error;
    }
    if (!data)
      return NextResponse.json({ ok: false, error: '사용자를 찾을 수 없습니다.' }, { status: 404 });
    return NextResponse.json({ ok: true, data });
  } catch (err: any) {
    console.error('[super/accounts/users PATCH]', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

// DELETE: 계정 삭제 = 탈퇴 처리 (0030). 행은 남기고 로그인·개인 내용을 없앤다 — user-withdrawal.ts
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: { message: '인증 필요' } }, { status: 401 });

  // 슈퍼관리자 본인 삭제 방지
  if (params.id === admin.sub)
    return NextResponse.json({ ok: false, error: { message: '본인 계정은 삭제할 수 없습니다.' } }, { status: 400 });

  try {
    const result = await withdrawUser(params.id, admin.sub);
    if (!result.ok)
      return NextResponse.json({ ok: false, error: { message: result.message } }, { status: result.status });

    // 감사 로그 (오류 무시)
    try {
      await supabaseAdmin.from('super_admin_logs').insert({
        admin_user_id: admin.sub,
        action: 'user_deleted',
        target_type: 'user',
        target_id: params.id,
        before_data: { email: result.before.email, name: result.before.full_name },
      });
    } catch { /* 감사 로그 실패는 무시 */ }

    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    console.error('[super/accounts/users DELETE]', err);
    return NextResponse.json({ ok: false, error: { message: '계정 삭제 중 오류가 발생했습니다.' } }, { status: 500 });
  }
}
