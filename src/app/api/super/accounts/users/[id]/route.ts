import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { listUserFilePaths, removeUserFiles } from '@/lib/generated-files';

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
      .select('id, email, full_name, role')
      .single();

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
    return NextResponse.json({ ok: true, data });
  } catch (err: any) {
    console.error('[super/accounts/users PATCH]', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

// DELETE: 계정 삭제 (Supabase Auth + users 테이블 동시 삭제)
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  // 슈퍼관리자 본인 삭제 방지
  if (params.id === admin.sub)
    return NextResponse.json({ ok: false, error: '본인 계정은 삭제할 수 없습니다.' }, { status: 400 });

  try {
    // 삭제 전 사용자 정보 저장 (로그용)
    const { data: user } = await supabaseAdmin
      .from('users').select('email, full_name').eq('id', params.id).maybeSingle();

    // 1) 생성 파일 경로를 먼저 모은다 — generated_files는 사용자와 함께 연쇄 삭제되고,
    //    DB 연쇄 삭제는 저장소 파일을 지우지 않는다. 지우는 것은 DB 삭제가 성공한 뒤다.
    //    (conversations·messages·usage_logs의 user_id는 ON DELETE 없음 — 대화나 사용 기록이
    //    있는 사용자는 아래 삭제가 외래 키에 막힐 수 있다. 그때 파일이 먼저 사라지면 안 된다)
    const filePaths = await listUserFilePaths(params.id);

    // 2) users 테이블에서 삭제
    const { error: dbErr } = await supabaseAdmin
      .from('users').delete().eq('id', params.id);
    if (dbErr) throw dbErr;

    // 2-1) 저장소 정리 (실패는 시스템 로그에 남기고 삭제는 계속)
    await removeUserFiles(params.id, filePaths);

    // 3) Supabase Auth에서 삭제
    const { error: authErr } = await supabaseAdmin.auth.admin.deleteUser(params.id);
    if (authErr) {
      console.warn('[delete user] Auth 삭제 실패 (DB는 삭제됨):', authErr.message);
    }

    // 4) 감사 로그 (오류 무시)
    try {
      await supabaseAdmin.from('super_admin_logs').insert({
        admin_user_id: admin.sub,
        action: 'user_deleted',
        target_type: 'user',
        target_id: params.id,
        before_data: { email: user?.email, name: user?.full_name },
      });
    } catch { /* 감사 로그 실패는 무시 */ }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[super/accounts/users DELETE]', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
