import { NextRequest, NextResponse } from 'next/server';
import { reportContractSync } from '@/lib/contract-sync';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getPlan } from '@/lib/plans';
import { parseContractInput } from '@/lib/contract-input';
import { dbErrorText } from '@/lib/db-error-text';
import { writeAuditRow } from '@/lib/audit-write';
import { contractAudit } from '@/lib/super-admin-log-spec';
import { contractsSummary, type RevenueContract } from '@/lib/contract-revenue';
import { pagedRows } from '@/lib/paged-select';

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

    // 요약 — 대시보드 '이번달 매출'과 같은 규칙(2026-11-18, `contractsSummary`). 못 읽으면 0으로 꾸미지 않는다
    const all = await pagedRows<RevenueContract>((a, b, w) => supabaseAdmin
      .from('contracts')
      .select('status, price_per_month, started_at, expires_at, updated_at', w ? { count: 'exact' } : undefined)
      .in('status', ['active', 'cancelled'])
      .order('id')
      .range(a, b));
    if (all.error) {
      return NextResponse.json({ ok: false, error: '계약 요약을 지금 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }, { status: 503 });
    }
    const { totalActive, expiringIn30Days: expiringIn30, totalMonthlyRevenue } = contractsSummary(all.data, now);

    return NextResponse.json({
      ok: true,
      data: contracts,
      meta: { total: count ?? 0, page, limit },
      summary: { totalActive, expiringIn30Days: expiringIn30, totalMonthlyRevenue },
    });
  } catch (err: any) {
    console.error('[super/contracts GET]', err);
    return NextResponse.json({ ok: false, error: dbErrorText(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  try {
    // 입력은 기존 계약을 끝내기 **전에** 본다 — 표 밖 요금제는 예전엔 체험 한도로 조용히 저장됐다(2026-11-19)
    const parsed = parseContractInput(await request.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.message }, { status: 400 });
    const { orgId, planType, monthlyFee, startDate, endDate, notes, billingType, annualBudgetKrw, budgetAlertPercent } = parsed.value;

    const plan = getPlan(planType);

    // 기존 active 계약 종료 — 못 끝내면 새 계약을 만들지 않는다(둘 다 active로 남지 않게, 2026-11-17)
    const { error: cancelErr } = await supabaseAdmin.from('contracts').update({ status: 'cancelled' })
      .eq('organization_id', orgId).eq('status', 'active');
    if (cancelErr) {
      await reportContractSync('cancel_previous_contract', orgId, cancelErr.code ?? 'error');
      return NextResponse.json({ ok: false, error: '기존 계약을 끝내지 못해 새 계약을 만들지 않았습니다. 잠시 뒤 다시 시도해 주세요.' }, { status: 500 });
    }

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
        price_per_month: monthlyFee,
        // 공공기관은 확정 금액으로 예산을 편성하므로 연간 정액 계약을 지원한다.
        // annual_fixed일 때는 토큰이 아니라 누적 사용액(원)으로 한도를 판정한다.
        billing_type: billingType,
        annual_budget_krw: annualBudgetKrw,
        budget_alert_percent: budgetAlertPercent,
        notes,
        created_by: admin.sub,
      })
      .select().single();

    if (cErr) throw cErr;

    // organizations 플랜 + 한도 동기화 — 실패하면 계약은 둔 채 경고(2026-11-17)
    const { error: orgErr } = await supabaseAdmin.from('organizations').update({
      plan: planType,
      max_users: plan.maxUsers,
      max_agents: plan.maxAgents,
      monthly_token_limit: plan.maxTokensPerMonth,
      status: 'active',
    }).eq('id', orgId);
    const warning = orgErr ? await reportContractSync('org_limits_after_contract', orgId, orgErr.code ?? 'error') : undefined;

    // 조작 기록(2026-11-17) — 계약은 돈과 한도를 정하므로 누가 언제 무엇으로 바꿨는지 남긴다
    await writeAuditRow('super_admin_logs', {
      admin_user_id: admin.sub,
      action: 'contract_created',
      target_type: 'contract',
      target_id: contract.id,
      after_data: contractAudit(contract),
    }, 'contract_created');

    return NextResponse.json({ ok: true, data: contract, ...(warning ? { warning } : {}) });
  } catch (err: any) {
    console.error('[super/contracts POST]', err);
    return NextResponse.json({ ok: false, error: dbErrorText(err) }, { status: 500 });
  }
}
