import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { pagedRows } from '@/lib/paged-select';
import { kstMonthStart } from '@/lib/kst-time';
import { writeAuditRow } from '@/lib/audit-write';
import { contractToRestore, reportContractSync, type ContractLite } from '@/lib/contract-sync';

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  try {
    const { status, plan, notes } = await request.json();
    const { id } = params;

    const { data: before } = await supabaseAdmin
      .from('organizations')
      .select('id, name, status, plan')
      .eq('id', id)
      .single();

    if (!before) {
      return NextResponse.json({ ok: false, error: '기관을 찾을 수 없습니다.' }, { status: 404 });
    }

    const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (status !== undefined) updateData.status = status;
    if (plan    !== undefined) updateData.plan   = plan;
    if (notes   !== undefined) updateData.notes  = notes;

    const { data: updated, error } = await supabaseAdmin
      .from('organizations')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    // 정지 시 active 계약을 해지, 다시 활성화하면 계약 하나만 되살린다(2026-11-17 — 예전에는 해지된 계약을 모두 되살려
    // 오래전에 끝난 계약까지 active가 되고 매출 합계가 부풀었다). 실패는 기관 변경을 되돌리지 않고 경고로
    let warning: string | undefined;
    if (status === 'suspended') {
      const { error: cancelErr } = await supabaseAdmin
        .from('contracts')
        .update({ status: 'cancelled' })
        .eq('organization_id', id)
        .eq('status', 'active');
      if (cancelErr) warning = await reportContractSync('contract_cancel_after_org_suspend', id, cancelErr.code ?? 'error');
    }
    if (status === 'active') {
      const { data: contracts, error: readErr } = await supabaseAdmin
        .from('contracts')
        .select('id, status, started_at, expires_at')
        .eq('organization_id', id)
        .in('status', ['active', 'cancelled']);
      const restoreId = readErr ? null : contractToRestore((contracts ?? []) as ContractLite[]);
      const { error: restoreErr } = restoreId
        ? await supabaseAdmin.from('contracts').update({ status: 'active' }).eq('id', restoreId).eq('status', 'cancelled')
        : { error: readErr };
      if (restoreErr) warning = await reportContractSync('contract_restore_after_org_active', id, restoreErr.code ?? 'error');
    }

    // 감사 로그
    await writeAuditRow('super_admin_logs', {
      admin_user_id: admin.sub,
      action: status === 'suspended' ? 'org_suspended' : 'org_updated',
      target_type: 'organization',
      target_id: id,
      before_data: before,
      after_data: updateData,
    }, status === 'suspended' ? 'org_suspended' : 'org_updated');

    return NextResponse.json({ ok: true, data: updated, ...(warning ? { warning } : {}) });
  } catch (err: any) {
    console.error('[super/organizations PATCH]', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  try {
    const { data: org, error } = await supabaseAdmin
      .from('organizations')
      .select(`
        *,
        departments (id, name, slug),
        contracts (id, plan, status, started_at, expires_at, price_per_month, max_users, max_agents)
      `)
      .eq('id', params.id)
      .single();

    if (error || !org) {
      return NextResponse.json({ ok: false, error: '기관을 찾을 수 없습니다.' }, { status: 404 });
    }

    // 사용자 수
    const { count: userCount } = await supabaseAdmin
      .from('users')
      .select('id', { count: 'exact', head: true })
      .in('department_id', (org.departments ?? []).map((d: any) => d.id))
      .is('deleted_at', null);

    // 이번달 토큰
    const { data: usageLogs } = await pagedRows<{ details: any }>((a, b, w) => supabaseAdmin
      .from('usage_logs')
      .select('details', w ? { count: 'exact' } : undefined)
      .eq('organization_id', params.id)
      .eq('action', 'chat_message')
      .gte('created_at', kstMonthStart().toISOString())
      .order('id').range(a, b));

    const tokensThisMonth = (usageLogs ?? []).reduce((sum: number, l: any) => {
      return sum + ((l.details?.input_tokens ?? 0) + (l.details?.output_tokens ?? 0));
    }, 0);

    return NextResponse.json({
      ok: true,
      data: { ...org, user_count: userCount ?? 0, tokens_this_month: tokensThisMonth },
    });
  } catch (err: any) {
    console.error('[super/organizations/:id GET]', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
