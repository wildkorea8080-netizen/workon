import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withdrawUser } from '@/lib/user-withdrawal';
import { writeAuditRow } from '@/lib/audit-write';
import { dbErrorText } from '@/lib/db-error-text';

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin)
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object')
      return NextResponse.json({ ok: false, error: '요청 형식이 올바르지 않습니다.' }, { status: 400 });
    const update: Record<string, unknown> = {};

    if (body.isActive !== undefined) {
      if (typeof body.isActive !== 'boolean')
        return NextResponse.json({ ok: false, error: '요청 형식이 올바르지 않습니다.' }, { status: 400 });
      update.is_active = body.isActive;
      // 다시 켜면 그때부터 장기 미접속을 센다(0095)
      if (body.isActive === true) update.reactivated_at = new Date().toISOString();
    }
    if (body.role !== undefined) {
      if (!['ADMIN', 'USER'].includes(body.role))
        return NextResponse.json({ ok: false, error: '유효하지 않은 role' }, { status: 400 });
      update.role = body.role;
      update.role_from_sso = false; // 손으로 바꾸면 기관 SSO 그룹 표시를 지운다(0115)
    }

    if (Object.keys(update).length === 0)
      return NextResponse.json({ ok: false, error: '바꿀 값이 없습니다.' }, { status: 400 });

    // 바꾸기 전 값 — 조작 기록에 남긴다(2026-11-17, 예전엔 사용 중지·권한 변경이 어디에도 안 남았다)
    // 2026-11-19 — 슈퍼관리자 계정은 이 길로 바꾸지 않는다(슈퍼관리자 탭의 '본인 아님·마지막 1명' 검사를 건너뛰어
    // 본인이나 마지막 슈퍼관리자를 끌 수 있었다). 전 값을 못 읽으면 바꾸지 않는다(예전엔 기록만 비었다)
    const { data: before, error: beforeError } = await supabaseAdmin
      .from('users').select('is_active, role, is_super_admin').eq('id', params.id).is('deleted_at', null).maybeSingle();
    if (beforeError)
      return NextResponse.json({ ok: false, error: '계정을 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }, { status: 503 });
    if (!before)
      return NextResponse.json({ ok: false, error: '사용자를 찾을 수 없습니다.' }, { status: 404 });
    if (before.is_super_admin)
      return NextResponse.json({ ok: false, error: '슈퍼관리자 계정은 슈퍼관리자 탭에서 바꿔 주세요.' }, { status: 400 });

    const { data, error } = await supabaseAdmin
      .from('users')
      .update(update)
      .eq('id', params.id)
      .eq('is_super_admin', false)
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
    await writeAuditRow('super_admin_logs', {
      admin_user_id: admin.sub,
      action: 'user_updated',
      target_type: 'user',
      target_id: params.id,
      before_data: { ...('is_active' in update ? { is_active: before.is_active } : {}), ...('role' in update ? { role: before.role } : {}) },
      after_data: { ...('is_active' in update ? { is_active: update.is_active } : {}), ...('role' in update ? { role: update.role } : {}) },
    }, 'user_updated');
    return NextResponse.json({ ok: true, data });
  } catch (err: any) {
    console.error('[super/accounts/users PATCH]', err);
    return NextResponse.json({ ok: false, error: dbErrorText(err) }, { status: 500 });
  }
}

// DELETE: 계정 삭제 = 탈퇴 처리 (0047). 행은 남기고 로그인·개인 내용을 없앤다 — user-withdrawal.ts
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
      await writeAuditRow('super_admin_logs', {
        admin_user_id: admin.sub,
        action: 'user_deleted',
        target_type: 'user',
        target_id: params.id,
        before_data: { email: result.before.email, name: result.before.full_name },
      }, 'user_deleted');
    } catch { /* 감사 로그 실패는 무시 */ }

    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    console.error('[super/accounts/users DELETE]', err);
    return NextResponse.json({ ok: false, error: { message: '계정 삭제 중 오류가 발생했습니다.' } }, { status: 500 });
  }
}
