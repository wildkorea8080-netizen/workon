import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const now     = new Date();
  const in30    = new Date(now.getTime() + 30 * 86400000);

  const { data, error } = await supabaseAdmin
    .from('contracts')
    .select('id, organization_id, plan, price_per_month, expires_at, organizations(name)')
    .eq('status', 'active')
    .not('expires_at', 'is', null)
    .lte('expires_at', in30.toISOString())
    .gte('expires_at', now.toISOString())
    .order('expires_at', { ascending: true });

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const result = (data ?? []).map((c: any) => ({
    id: c.id,
    orgId: c.organization_id,
    orgName: c.organizations?.name ?? '—',
    plan: c.plan,
    monthlyFee: Number(c.price_per_month ?? 0),
    endDate: c.expires_at,
    daysLeft: Math.ceil((new Date(c.expires_at).getTime() - now.getTime()) / 86400000),
  }));

  return NextResponse.json({ ok: true, data: result });
}
