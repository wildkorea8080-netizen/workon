import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const now        = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
  const in30 = new Date(now.getTime() + 30 * 86400000).toISOString();

  try {
    // ── 병렬 쿼리 ──────────────────────────────────────────
    const [
      orgAll, orgActive, orgSuspended, orgExpiring,
      userAll, userNew, userToday,
      todayUsage, monthUsage,
      revenueThis, revenueLast,
      tokenAlerts, tokenExceeded,
      recentOrgs, recentLogs,
    ] = await Promise.all([
      supabaseAdmin.from('organizations').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('organizations').select('id', { count: 'exact', head: true }).eq('status', 'active'),
      supabaseAdmin.from('organizations').select('id', { count: 'exact', head: true }).eq('status', 'suspended'),
      supabaseAdmin.from('contracts').select('id', { count: 'exact', head: true })
        .eq('status', 'active').not('expires_at', 'is', null).lte('expires_at', in30).gte('expires_at', now.toISOString()),
      supabaseAdmin.from('users').select('id', { count: 'exact', head: true }).eq('is_super_admin', false),
      supabaseAdmin.from('users').select('id', { count: 'exact', head: true }).eq('is_super_admin', false).gte('created_at', monthStart),
      supabaseAdmin.from('usage_logs').select('user_id', { count: 'exact', head: true }).eq('action', 'chat_message').gte('created_at', todayStart),
      supabaseAdmin.from('usage_logs').select('details').eq('action', 'chat_message').gte('created_at', todayStart),
      supabaseAdmin.from('usage_logs').select('details').eq('action', 'chat_message').gte('created_at', monthStart),
      supabaseAdmin.from('contracts').select('price_per_month').eq('status', 'active').gte('started_at', monthStart),
      supabaseAdmin.from('contracts').select('price_per_month').eq('status', 'active').gte('started_at', lastMonthStart).lt('started_at', monthStart),
      // 80~100% 경고 기관
      (async () => {
        const { data: orgs } = await supabaseAdmin.from('organizations').select('id, monthly_token_limit').eq('status', 'active');
        const { data: logs } = await supabaseAdmin.from('usage_logs').select('organization_id, details').eq('action', 'chat_message').gte('created_at', monthStart);
        const usageMap = new Map<string, number>();
        for (const l of logs ?? []) {
          const oid = l.organization_id;
          if (!oid) continue;
          usageMap.set(oid, (usageMap.get(oid) ?? 0) + ((l.details?.input_tokens ?? 0) + (l.details?.output_tokens ?? 0)));
        }
        let warn = 0;
        for (const o of orgs ?? []) {
          if (!o.monthly_token_limit) continue;
          const pct = (usageMap.get(o.id) ?? 0) / o.monthly_token_limit * 100;
          if (pct >= 80 && pct < 100) warn++;
        }
        return warn;
      })(),
      (async () => {
        const { data: orgs } = await supabaseAdmin.from('organizations').select('id, monthly_token_limit').eq('status', 'active');
        const { data: logs } = await supabaseAdmin.from('usage_logs').select('organization_id, details').eq('action', 'chat_message').gte('created_at', monthStart);
        const usageMap = new Map<string, number>();
        for (const l of logs ?? []) {
          const oid = l.organization_id; if (!oid) continue;
          usageMap.set(oid, (usageMap.get(oid) ?? 0) + ((l.details?.input_tokens ?? 0) + (l.details?.output_tokens ?? 0)));
        }
        return (orgs ?? []).filter(o => o.monthly_token_limit && (usageMap.get(o.id) ?? 0) >= o.monthly_token_limit).length;
      })(),
      supabaseAdmin.from('organizations').select('id, name, plan, status, created_at').order('created_at', { ascending: false }).limit(5),
      supabaseAdmin.from('system_logs').select('level, message, created_at').in('level', ['error', 'critical']).order('created_at', { ascending: false }).limit(5),
    ]);

    // ── 사용량 집계 ──────────────────────────────────────
    const todayConversations = todayUsage.count ?? 0;
    const monthConversations = (monthUsage.data ?? []).length;
    let monthInput = 0, monthOutput = 0;
    for (const l of monthUsage.data ?? []) {
      monthInput  += (l.details?.input_tokens  ?? 0);
      monthOutput += (l.details?.output_tokens ?? 0);
    }
    const monthTokens     = monthInput + monthOutput;
    const estimatedCostUsd = parseFloat(((monthInput / 1_000_000) * 3 + (monthOutput / 1_000_000) * 15).toFixed(4));

    // ── 매출 집계 ──────────────────────────────────────
    const thisMonthRevenue = (revenueThis.data ?? []).reduce((s: number, c: any) => s + Number(c.price_per_month ?? 0), 0);
    const lastMonthRevenue = (revenueLast.data ?? []).reduce((s: number, c: any) => s + Number(c.price_per_month ?? 0), 0);
    const growthPercent    = lastMonthRevenue === 0 ? null : Math.round(((thisMonthRevenue - lastMonthRevenue) / lastMonthRevenue) * 100);

    // ── 최근 30일 일별 대화수 ──────────────────────────
    const { data: dailyLogs } = await supabaseAdmin
      .from('usage_logs').select('created_at').eq('action', 'chat_message')
      .gte('created_at', new Date(now.getTime() - 29 * 86400000).toISOString())
      .order('created_at', { ascending: true });

    const dailyMap = new Map<string, number>();
    for (const l of dailyLogs ?? []) {
      const d = l.created_at.slice(0, 10);
      dailyMap.set(d, (dailyMap.get(d) ?? 0) + 1);
    }
    const dailyChart: { date: string; count: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10);
      dailyChart.push({ date: d, count: dailyMap.get(d) ?? 0 });
    }

    // ── 플랜별 기관 분포 ──────────────────────────────
    const { data: planDist } = await supabaseAdmin
      .from('organizations').select('plan').eq('status', 'active');
    const planMap = new Map<string, number>();
    for (const o of planDist ?? []) {
      const p = o.plan ?? 'trial';
      planMap.set(p, (planMap.get(p) ?? 0) + 1);
    }
    const planChart = [...planMap.entries()].map(([name, value]) => ({ name, value }));

    // ── 이번달 사용량 Top 5 기관 ──────────────────────
    const { data: topLogs } = await supabaseAdmin
      .from('usage_logs').select('organization_id, details')
      .eq('action', 'chat_message').gte('created_at', monthStart);
    const topMap = new Map<string, number>();
    for (const l of topLogs ?? []) {
      const oid = l.organization_id; if (!oid) continue;
      topMap.set(oid, (topMap.get(oid) ?? 0) + ((l.details?.input_tokens ?? 0) + (l.details?.output_tokens ?? 0)));
    }
    const top5Ids = [...topMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => id);
    let topUsageOrgs: any[] = [];
    if (top5Ids.length > 0) {
      const { data: topOrgs } = await supabaseAdmin.from('organizations')
        .select('id, name, monthly_token_limit').in('id', top5Ids);
      topUsageOrgs = top5Ids.map(id => {
        const org = (topOrgs ?? []).find((o: any) => o.id === id);
        const tokens = topMap.get(id) ?? 0;
        const limit  = org?.monthly_token_limit ?? 0;
        return { id, name: org?.name ?? '—', tokens, usagePct: limit > 0 ? Math.round(tokens / limit * 100) : 0 };
      });
    }

    return NextResponse.json({
      ok: true,
      data: {
        organizations: {
          total: orgAll.count ?? 0,
          active: orgActive.count ?? 0,
          suspended: orgSuspended.count ?? 0,
          expiringIn30Days: orgExpiring.count ?? 0,
        },
        users: {
          total: userAll.count ?? 0,
          newThisMonth: userNew.count ?? 0,
          activeToday: userToday.count ?? 0,
        },
        usage: { todayConversations, monthConversations, monthTokens, estimatedCostUsd },
        revenue: { thisMonth: thisMonthRevenue, lastMonth: lastMonthRevenue, growthPercent },
        alerts: {
          tokenWarnings:     typeof tokenAlerts === 'number' ? tokenAlerts : 0,
          tokenExceeded:     typeof tokenExceeded === 'number' ? tokenExceeded : 0,
          expiringContracts: orgExpiring.count ?? 0,
        },
        recentOrgs:     recentOrgs.data ?? [],
        topUsageOrgs,
        recentSystemLogs: recentLogs.data ?? [],
        dailyChart,
        planChart,
      },
    });
  } catch (err: any) {
    console.error('[super/dashboard GET]', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
