import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { dbErrorText } from '@/lib/db-error-text';
import { contractDaysLeft, isContractOverdue } from '@/lib/contract-expiry';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const now     = new Date();
  const in30    = new Date(now.getTime() + 30 * 86400000);

  const { data, error } = await supabaseAdmin
    .from('contracts')
    .select('id, organization_id, plan, price_per_month, expires_at, status, organizations(name)')
    .eq('status', 'active')
    .not('expires_at', 'is', null)
    .lte('expires_at', in30.toISOString())
    // 기한이 이미 지난 'active' 계약도(2026-11-19 — 예전엔 앞으로 30일 안만 봐 지난 계약은 어떤 알림에도 없었다)
    .order('expires_at', { ascending: true });

  if (error) return NextResponse.json({ ok: false, error: dbErrorText(error) }, { status: 500 });

  const result = (data ?? []).map((c: any) => ({
    id: c.id,
    orgId: c.organization_id,
    orgName: c.organizations?.name ?? '—',
    plan: c.plan,
    monthlyFee: Number(c.price_per_month ?? 0),
    endDate: c.expires_at,
    daysLeft: contractDaysLeft(c.expires_at, now.getTime()),
    overdue: isContractOverdue(c.status ?? 'active', c.expires_at, now.getTime()),
  }));

  return NextResponse.json({ ok: true, data: result });
}
