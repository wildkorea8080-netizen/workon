import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const { data, error } = await supabaseAdmin
    .from('system_settings').select('*').order('key');

  if (error) {
    console.warn('[super/settings GET]', error.message);
    return NextResponse.json({ ok: true, data: [] });
  }
  return NextResponse.json({ ok: true, data: data ?? [] });
}

export async function PATCH(request: NextRequest) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  try {
    const { key, value } = await request.json();
    if (!key || value === undefined) return NextResponse.json({ ok: false, error: 'key, value 필수' }, { status: 400 });

    const { data, error } = await supabaseAdmin
      .from('system_settings')
      .upsert({ key, value: String(value), updated_by: admin.sub, updated_at: new Date().toISOString() }, { onConflict: 'key' })
      .select().single();

    if (error) throw error;
    return NextResponse.json({ ok: true, data });
  } catch (err: any) {
    console.error('[super/settings PATCH]', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
