import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { data } = await supabaseAdmin
      .from('system_settings')
      .select('key, value')
      .in('key', ['maintenance_mode', 'maintenance_message']);

    const map = Object.fromEntries((data ?? []).map((r: any) => [r.key, r.value]));
    return NextResponse.json({
      ok: true,
      isMaintenance: map.maintenance_mode === 'true',
      message: map.maintenance_message ?? '시스템 점검 중입니다.',
    });
  } catch {
    return NextResponse.json({ ok: true, isMaintenance: false, message: '' });
  }
}
