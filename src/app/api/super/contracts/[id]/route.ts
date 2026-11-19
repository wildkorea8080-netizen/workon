import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getPlan } from '@/lib/plans';
import { reportContractSync } from '@/lib/contract-sync';
import { dbErrorText } from '@/lib/db-error-text';
import { writeAuditRow } from '@/lib/audit-write';
import { contractAudit, changedFields } from '@/lib/super-admin-log-spec';
import { parseContractPatch } from '@/lib/contract-input';
import { kstDay } from '@/lib/kst-time';

export const dynamic = 'force-dynamic';

// PATCH: 계약 갱신·해지
//
// 2026-11-19 — 입력을 먼저 본다(`parseContractPatch`). 또 예전에는
// ① 이미 끝난 계약을 다시 '해지'해도 기관을 정지시켰고(그 기관의 지금 계약이 살아 있어도)
// ② 끝난 옛 계약의 요금제를 바꿔도 기관 한도를 그 요금제로 덮었으며
// ③ 계약 행의 인원·비서·토큰 한도는 요금제를 바꿔도 그대로였고 ④ 대상이 없으면 500이었다.
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const parsed = parseContractPatch(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.message }, { status: 400 });
  const { status, notes, endDate, planType, monthlyFee, billingType, annualBudgetKrw, budgetAlertPercent } = parsed.value;

  try {
    // 바꾸기 전 값 — 판정과 조작 기록(2026-11-17)에 쓴다. 못 읽으면 바꾸지 않는다
    const { data: before, error: beforeError } = await supabaseAdmin.from('contracts').select('*').eq('id', params.id).maybeSingle();
    if (beforeError) return NextResponse.json({ ok: false, error: '계약을 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }, { status: 503 });
    if (!before) return NextResponse.json({ ok: false, error: '계약을 찾을 수 없습니다.' }, { status: 404 });
    const wasActive = before.status === 'active';

    if (status === 'cancelled' && !wasActive)
      return NextResponse.json({ ok: false, error: '이미 끝난 계약입니다.' }, { status: 409 });
    if (endDate && before.started_at && endDate < kstDay(before.started_at))
      return NextResponse.json({ ok: false, error: '종료일이 계약 시작일보다 앞섭니다.' }, { status: 400 });

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (status)    update.status      = status;
    if (notes !== undefined) update.notes = notes;
    if (endDate)   update.expires_at  = new Date(endDate).toISOString();
    if (monthlyFee !== undefined) update.price_per_month = monthlyFee;
    if (planType) {
      // 계약 행의 한도도 요금제에 맞춘다 — 만들 때와 같은 값
      const plan = getPlan(planType);
      update.plan = planType;
      update.max_users = plan.maxUsers;
      update.max_agents = plan.maxAgents;
      update.monthly_token_limit = plan.maxTokensPerMonth;
    }
    if (billingType !== undefined) {
      update.billing_type = billingType;
      // 종량제로 되돌리면 예산 금액은 의미가 없으므로 비운다
      if (billingType === 'pay_as_you_go') update.annual_budget_krw = null;
    }
    if (annualBudgetKrw !== undefined && billingType !== 'pay_as_you_go') update.annual_budget_krw = annualBudgetKrw;
    if (budgetAlertPercent !== undefined) update.budget_alert_percent = budgetAlertPercent;

    const { data: contract, error } = await supabaseAdmin
      .from('contracts').update(update).eq('id', params.id).select('*, organization_id').maybeSingle();

    if (error) throw error;
    if (!contract) return NextResponse.json({ ok: false, error: '계약을 찾을 수 없습니다.' }, { status: 404 });

    // 기관 맞추기 실패는 계약 변경을 되돌리지 않고 경고로(2026-11-17)
    const warnings: string[] = [];

    // 해지 시 기관 suspended 처리 — 살아 있던 계약을 끝낼 때만
    if (status === 'cancelled' && contract.organization_id) {
      const { error: suspendErr } = await supabaseAdmin.from('organizations')
        .update({ status: 'suspended' }).eq('id', contract.organization_id);
      if (suspendErr) warnings.push(await reportContractSync('org_suspend_after_cancel', contract.organization_id, suspendErr.code ?? 'error'));
    }

    // 플랜 변경 시 organizations 동기화 — 지금 계약(바꾸기 전 active, 이번에 해지하지 않음)일 때만.
    // 끝난 옛 계약의 요금제를 고쳐도 기관 한도는 그대로다
    if (planType && wasActive && status !== 'cancelled' && contract.organization_id) {
      const plan = getPlan(planType);
      const { error: planErr } = await supabaseAdmin.from('organizations').update({
        plan: planType,
        max_users: plan.maxUsers,
        max_agents: plan.maxAgents,
        monthly_token_limit: plan.maxTokensPerMonth,
      }).eq('id', contract.organization_id);
      if (planErr) warnings.push(await reportContractSync('org_plan_after_contract_change', contract.organization_id, planErr.code ?? 'error'));
    }

    const diff = changedFields(contractAudit(before), contractAudit(contract));
    await writeAuditRow('super_admin_logs', {
      admin_user_id: admin.sub,
      action: status === 'cancelled' ? 'contract_cancelled' : 'contract_updated',
      target_type: 'contract',
      target_id: params.id,
      before_data: diff.before,
      after_data: diff.after,
    }, status === 'cancelled' ? 'contract_cancelled' : 'contract_updated');

    return NextResponse.json({ ok: true, data: contract, ...(warnings.length ? { warning: warnings.join(' ') } : {}) });
  } catch (err: any) {
    console.error('[super/contracts PATCH]', err);
    return NextResponse.json({ ok: false, error: dbErrorText(err) }, { status: 500 });
  }
}
