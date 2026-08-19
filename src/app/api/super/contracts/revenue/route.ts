import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sumCostUsd, usdToKrw } from '@/lib/models';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const year = parseInt(new URL(request.url).searchParams.get('year') ?? String(new Date().getFullYear()));

  try {
    // 해당 연도 활성 계약 전체 조회
    const { data: contracts } = await supabaseAdmin
      .from('contracts')
      .select('organization_id, plan, price_per_month, started_at, expires_at, status')
      .or(`status.eq.active,status.eq.cancelled`)
      .gte('started_at', `${year}-01-01`)
      .lte('started_at', `${year}-12-31T23:59:59`);

    // 해당 연도 usage_logs (API 비용 추정)
    const { data: usageLogs } = await supabaseAdmin
      .from('usage_logs')
      .select('details, created_at')
      .eq('action', 'chat_message')
      .gte('created_at', `${year}-01-01`)
      .lte('created_at', `${year}-12-31T23:59:59`);

    // 월별 집계
    const monthly: any[] = [];
    let totalRevenue = 0;
    let totalCostUsd = 0;

    for (let m = 1; m <= 12; m++) {
      const mStart = new Date(year, m - 1, 1);
      const mEnd   = new Date(year, m, 0, 23, 59, 59);

      // 해당 월에 활성인 계약 찾기
      const activeContracts = (contracts ?? []).filter((c: { started_at: string; expires_at?: string }) => {
        const s = new Date(c.started_at);
        const e = c.expires_at ? new Date(c.expires_at) : new Date('2099-01-01');
        return s <= mEnd && e >= mStart;
      });

      const revenue  = activeContracts.reduce((sum: number, c: { price_per_month?: number }) => sum + Number(c.price_per_month ?? 0), 0);
      const orgCount = activeContracts.length;

      // API 비용 (해당 월)
      const monthLogs = (usageLogs ?? []).filter((l: { created_at: string }) => {
        const d = new Date(l.created_at);
        return d >= mStart && d <= mEnd;
      });
      const inpTokens = monthLogs.reduce((s: number, l: { details?: any }) => s + ((l.details?.input_tokens  as number) ?? 0), 0);
      const outTokens = monthLogs.reduce((s: number, l: { details?: any }) => s + ((l.details?.output_tokens as number) ?? 0), 0);
      // 로그에 cost_usd가 있으면 기록 시점 단가를, 없으면 기본 모델 단가로 추정
      const apiCostUsd = sumCostUsd(monthLogs);
      const apiCostKrw = usdToKrw(apiCostUsd);
      const netProfit  = revenue - apiCostKrw;

      totalRevenue += revenue;
      totalCostUsd += apiCostUsd;

      monthly.push({ month: m, revenue, orgCount, apiCostUsd, apiCostKrw, netProfit, inpTokens, outTokens });
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
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
