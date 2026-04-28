import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

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

    if (error) throw error;
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

    // 1) 관련 데이터 정리 (대화, 메시지는 CASCADE로 자동 삭제)
    // conversations는 user_id ON DELETE SET NULL이므로 별도 삭제 불필요

    // 2) users 테이블에서 삭제
    const { error: dbErr } = await supabaseAdmin
      .from('users').delete().eq('id', params.id);
    if (dbErr) throw dbErr;

    // 3) Supabase Auth에서 삭제
    const { error: authErr } = await supabaseAdmin.auth.admin.deleteUser(params.id);
    if (authErr) {
      console.warn('[delete user] Auth 삭제 실패 (DB는 삭제됨):', authErr.message);
    }

    // 4) 감사 로그
    await supabaseAdmin.from('super_admin_logs').insert({
      admin_user_id: admin.sub,
      action: 'user_deleted',
      target_type: 'user',
      target_id: params.id,
      before_data: { email: user?.email, name: user?.full_name },
    }).catch(() => {});

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[super/accounts/users DELETE]', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
