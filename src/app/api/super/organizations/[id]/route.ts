import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { seatDeps } from '@/lib/user-seats';
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

    // 한도 현황(2026-11-17 고침) — 사용자는 상한 판정과 같은 수(활성·탈퇴 안 한 계정, `user-seats.ts`),
    // 비서는 지우지 않은 비서 수(예전엔 칸이 없어 늘 0이었고 막대는 부서 수로 그렸다), 토큰은 한도 판정과 같은 DB 합(0057).
    // 못 읽은 값은 null — 0으로 보이면 '여유 있음'으로 읽힌다
    const [userCount, agentCount, tokens] = await Promise.all([
      seatDeps().activeUsers(params.id).catch(() => null),
      (async () => {
        const { count, error: e } = await supabaseAdmin.from('agents').select('id', { count: 'exact', head: true })
          .eq('organization_id', params.id).is('deleted_at', null);
        return e || typeof count !== 'number' ? null : count;
      })().catch(() => null),
      (async () => {
        const { data, error: e } = await supabaseAdmin.rpc('organization_chat_tokens', { p_organization_id: params.id, p_from: kstMonthStart().toISOString() });
        return e ? null : Number(data ?? 0);
      })().catch(() => null),
    ]);

    return NextResponse.json({
      ok: true,
      data: { ...org, user_count: userCount, agent_count: agentCount, tokens_this_month: tokens },
    });
  } catch (err: any) {
    console.error('[super/organizations/:id GET]', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
