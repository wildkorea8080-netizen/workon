import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getPlan } from '@/lib/plans';

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  try {
    const body = await request.json();
    const { status, notes, endDate, planType, monthlyFee } = body;

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (status)    update.status      = status;
    if (notes !== undefined) update.notes = notes;
    if (endDate)   update.expires_at  = new Date(endDate).toISOString();
    if (planType)  update.plan        = planType;
    if (monthlyFee !== undefined) update.price_per_month = monthlyFee;

    const { data: contract, error } = await supabaseAdmin
      .from('contracts').update(update).eq('id', params.id).select('*, organization_id').single();

    if (error) throw error;

    // 해지 시 기관 suspended 처리
    if (status === 'cancelled' && contract.organization_id) {
      await supabaseAdmin.from('organizations')
        .update({ status: 'suspended' }).eq('id', contract.organization_id);
    }

    // 플랜 변경 시 organizations 동기화
    if (planType && contract.organization_id) {
      const plan = getPlan(planType);
      await supabaseAdmin.from('organizations').update({
        plan: planType,
        max_users: plan.maxUsers,
        max_agents: plan.maxAgents,
        monthly_token_limit: plan.maxTokensPerMonth,
      }).eq('id', contract.organization_id);
    }

    return NextResponse.json({ ok: true, data: contract });
  } catch (err: any) {
    console.error('[super/contracts PATCH]', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
