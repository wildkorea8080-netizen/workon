import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  try {
    const { isActive } = await request.json();

    if (isActive === false) {
      // 본인 계정 비활성화 불가
      if (params.id === admin.sub)
        return NextResponse.json({ ok: false, error: '본인 계정은 비활성화할 수 없습니다.' }, { status: 400 });

      // 마지막 1명 비활성화 불가
      const { count } = await supabaseAdmin
        .from('users').select('id', { count: 'exact', head: true })
        .eq('is_super_admin', true).eq('is_active', true);
      if ((count ?? 0) <= 1)
        return NextResponse.json({ ok: false, error: '최소 1명의 슈퍼관리자가 필요합니다.' }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin
      .from('users')
      .update({ is_active: isActive })
      .eq('id', params.id)
      .eq('is_super_admin', true)
      .select('id, email, is_active').single();

    if (error) throw error;
    return NextResponse.json({ ok: true, data });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
