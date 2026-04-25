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
