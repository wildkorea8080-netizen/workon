import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getPlan } from '@/lib/plans';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status') ?? 'all';
  const orgId  = searchParams.get('orgId')  ?? '';
  const page   = Math.max(1, parseInt(searchParams.get('page')  ?? '1'));
  const limit  = Math.min(100, parseInt(searchParams.get('limit') ?? '30'));

  try {
    let query = supabaseAdmin
      .from('contracts')
      .select('*, organizations(id, name, status)', { count: 'exact' });

    if (status !== 'all') query = query.eq('status', status);
    if (orgId)            query = query.eq('organization_id', orgId);

    const { data: rows, count, error } = await query
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (error) throw error;

    const now = Date.now();
    const contracts = (rows ?? []).map((c: any) => {
      const daysLeft = c.expires_at
        ? Math.ceil((new Date(c.expires_at).getTime() - now) / 86400000)
        : null;
      return {
        id: c.id,
        orgId: c.organization_id,
        orgName: c.organizations?.name ?? '—',
        planType: c.plan ?? 'basic',
        monthlyFee: Number(c.price_per_month ?? 0),
        startDate: c.started_at,
        endDate: c.expires_at,
        status: c.status,
        daysLeft,
        notes: c.notes,
        maxUsers: c.max_users,
        maxAgents: c.max_agents,
        maxTokens: c.monthly_token_limit,
      };
    });

    // 요약
    const { data: allActive } = await supabaseAdmin
      .from('contracts').select('price_per_month, expires_at').eq('status', 'active');

    const totalActive = (allActive ?? []).length;
    const expiringIn30 = (allActive ?? []).filter((c: { expires_at?: string }) =>
      c.expires_at && Math.ceil((new Date(c.expires_at).getTime() - now) / 86400000) <= 30 && new Date(c.expires_at).getTime() > now
    ).length;
    const totalMonthlyRevenue = (allActive ?? []).reduce((s: number, c: { price_per_month?: number }) => s + Number(c.price_per_month ?? 0), 0);

    return NextResponse.json({
      ok: true,
      data: contracts,
      meta: { total: count ?? 0, page, limit },
      summary: { totalActive, expiringIn30Days: expiringIn30, totalMonthlyRevenue },
    });
  } catch (err: any) {
    console.error('[super/contracts GET]', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  try {
    const { orgId, planType, monthlyFee, startDate, endDate, notes } = await request.json();
    if (!orgId || !planType) return NextResponse.json({ ok: false, error: 'orgId, planType 필수' }, { status: 400 });

    const plan = getPlan(planType);

    // 기존 active 계약 종료
    await supabaseAdmin.from('contracts').update({ status: 'cancelled' })
      .eq('organization_id', orgId).eq('status', 'active');

    // 새 계약 INSERT
    const { data: contract, error: cErr } = await supabaseAdmin
      .from('contracts')
      .insert({
        organization_id: orgId,
        plan: planType,
        status: 'active',
        started_at: startDate ? new Date(startDate).toISOString() : new Date().toISOString(),
        expires_at: endDate ? new Date(endDate).toISOString() : null,
        max_users: plan.maxUsers,
        max_agents: plan.maxAgents,
        monthly_token_limit: plan.maxTokensPerMonth,
        price_per_month: monthlyFee ?? plan.monthlyFee,
        notes: notes ?? null,
        created_by: admin.sub,
      })
      .select().single();

    if (cErr) throw cErr;

    // organizations 플랜 + 한도 동기화
    await supabaseAdmin.from('organizations').update({
      plan: planType,
      max_users: plan.maxUsers,
      max_agents: plan.maxAgents,
      monthly_token_limit: plan.maxTokensPerMonth,
      status: 'active',
    }).eq('id', orgId);

    return NextResponse.json({ ok: true, data: contract });
  } catch (err: any) {
    console.error('[super/contracts POST]', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
