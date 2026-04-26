import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const sp    = new URL(request.url).searchParams;
  const page  = Math.max(1, parseInt(sp.get('page')  ?? '1'));
  const limit = Math.min(100, parseInt(sp.get('limit') ?? '50'));

  try {
    const { data, count, error } = await supabaseAdmin
      .from('impersonation_logs')
      .select(`
        id, accessed_at, ended_at, ip_address, note,
        super_admin_id,
        org_id,
        target_user_id,
        organizations(id, name),
        users!impersonation_logs_super_admin_id_fkey(id, email, full_name)
      `, { count: 'exact' })
      .order('accessed_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (error) throw error;

    const rows = (data ?? []).map((r: any) => {
      const accessedMs = new Date(r.accessed_at).getTime();
      const endedMs    = r.ended_at ? new Date(r.ended_at).getTime() : null;
      const durationSec = endedMs ? Math.floor((endedMs - accessedMs) / 1000) : null;
      return {
        id: r.id,
        accessedAt: r.accessed_at,
        endedAt:    r.ended_at,
        ipAddress:  r.ip_address,
        orgName:    r.organizations?.name ?? '—',
        superAdminEmail: r.users?.email ?? '—',
        superAdminName:  r.users?.full_name ?? '—',
        durationSec,
        isActive: !r.ended_at,
      };
    });

    return NextResponse.json({ ok: true, data: rows, meta: { total: count ?? 0, page, limit } });
  } catch (err: any) {
    console.warn('[super/logs/impersonation GET]', err.message);
    return NextResponse.json({ ok: true, data: [], meta: { total: 0, page, limit } });
  }
}
