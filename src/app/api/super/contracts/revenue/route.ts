import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { pagedRows } from '@/lib/paged-select';
import { sumCostUsd, usdToKrw } from '@/lib/models';
import { dbErrorText } from '@/lib/db-error-text';
import { kstMonthRange, kstYearMonth, revenueIn, type RevenueContract } from '@/lib/contract-revenue';
import { tokenNumber } from '@/lib/cost-rows';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  // 연·월은 한국 시간(2026-11-17 — 예전엔 UTC 경계). 그해에 유효했던 계약은 그해 전에 시작했어도 센다(`contract-revenue.ts`)
  const nowYm = kstYearMonth();
  const yearRaw = parseInt(new URL(request.url).searchParams.get('year') ?? String(nowYm.year), 10);
  const year = Number.isFinite(yearRaw) && yearRaw >= 2000 && yearRaw <= 2100 ? yearRaw : nowYm.year;
  const [yearStartMs] = kstMonthRange(year, 1);
  const [, yearEndExMs] = kstMonthRange(year, 12);

  try {
    // 그해가 끝나기 전에 시작한 계약 — 끝난 때는 아래 규칙으로 거른다
    const { data: contracts, error: contractErr } = await supabaseAdmin
      .from('contracts')
      .select('organization_id, plan, price_per_month, started_at, expires_at, updated_at, status')
      .in('status', ['active', 'cancelled'])
      .lt('started_at', new Date(yearEndExMs).toISOString());
    if (contractErr) throw contractErr;

    // 해당 연도 usage_logs (API 비용) — 모든 활동(2026-11-19 — 예전엔 chat_message만이라 업무 작업·평가 등의 원가가 빠졌다)
    const { data: usageLogs, error: usageErr } = await pagedRows<{ details: any; created_at: string }>((a, b, w) => supabaseAdmin
      .from('usage_logs')
      .select('details, created_at', w ? { count: 'exact' } : undefined)
      .gte('created_at', new Date(yearStartMs).toISOString())
      .lt('created_at', new Date(yearEndExMs).toISOString())
      .order('id').range(a, b));
    if (usageErr) throw usageErr;

    // 월별 집계
    const monthly: any[] = [];
    let totalRevenue = 0;
    let totalCostUsd = 0;

    for (let m = 1; m <= 12; m++) {
      const [mStartMs, mEndExMs] = kstMonthRange(year, m);
      // 아직 오지 않은 달은 매출로 세지 않는다(연간 합이 앞날까지 더해지지 않게)
      const future = year > nowYm.year || (year === nowYm.year && m > nowYm.month);

      const { revenue, count: orgCount } = future ? { revenue: 0, count: 0 } : revenueIn((contracts ?? []) as RevenueContract[], mStartMs, mEndExMs);

      // API 비용 (해당 월)
      const monthLogs = (usageLogs ?? []).filter((l: { created_at: string }) => {
        const d = Date.parse(l.created_at);
        return d >= mStartMs && d < mEndExMs;
      });
      const inpTokens = monthLogs.reduce((s: number, l: { details?: any }) => s + tokenNumber(l.details?.input_tokens), 0);
      const outTokens = monthLogs.reduce((s: number, l: { details?: any }) => s + tokenNumber(l.details?.output_tokens), 0);
      // 로그에 cost_usd가 있으면 기록 시점 단가를, 없으면 기본 모델 단가로 추정
      const apiCostUsd = sumCostUsd(monthLogs);
      const apiCostKrw = usdToKrw(apiCostUsd);
      const netProfit  = revenue - apiCostKrw;

      totalRevenue += revenue;
      totalCostUsd += apiCostUsd;

      monthly.push({ month: m, revenue, orgCount, apiCostUsd, apiCostKrw, netProfit, inpTokens, outTokens, future });
    }

    return NextResponse.json({
      ok: true,
      data: {
        monthly,
        annual: {
          totalRevenue,
          totalCostUsd: parseFloat(totalCostUsd.toFixed(4)),
          totalCostKrw: usdToKrw(totalCostUsd),
          totalProfit: totalRevenue - usdToKrw(totalCostUsd),
        },
      },
    });
  } catch (err: any) {
    console.error('[super/contracts/revenue GET]', err);
    return NextResponse.json({ ok: false, error: dbErrorText(err) }, { status: 500 });
  }
}
