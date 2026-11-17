import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { pagedRows } from '@/lib/paged-select';
import { estimateCostUsd } from '@/lib/models';
import { addKstDays, kstDay, kstDayStart, kstMonthStart } from '@/lib/kst-time';
import { CRITICAL_WINDOW_MS, criticalSummary } from '@/lib/super-log-links';
import { IP_LOCK_STARTED, LOCK_WINDOW_MS, lockedIpCount } from '@/lib/sign-in-throttle';
import { seatAlerts } from '@/lib/user-seats';
import { dbErrorText } from '@/lib/db-error-text';
import { loadChatTokensByOrg } from '@/lib/org-chat-tokens';
import { revenueIn, type RevenueContract } from '@/lib/contract-revenue';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const now        = new Date();
  // 오늘·이번 달·지난달은 한국 날짜로(서버는 UTC — 예전에는 하루가 09:00 KST에 시작했다, 2026-11-06)
  const todayStart = kstDayStart(kstDay(now)).toISOString();
  const monthStart = kstMonthStart(now, 0).toISOString();
  const lastMonthStart = kstMonthStart(now, -1).toISOString();
  const nextMonthStart = kstMonthStart(now, 1).toISOString();
  const in30 = new Date(now.getTime() + 30 * 86400000).toISOString();

  try {
    // ── 병렬 쿼리 ──────────────────────────────────────────
    // 기관별 이번 달 토큰(한도 판정과 같은 셈) — 경고·초과·Top 5가 함께 쓴다
    const monthTokensP = loadChatTokensByOrg(monthStart);
    const [
      orgAll, orgActive, orgSuspended, orgExpiring,
      userAll, userNew, userToday,
      todayUsage, monthUsage,
      revenueContracts,
      tokenAlerts, tokenExceeded,
      recentOrgs, recentLogs, criticalRecent, ipFailures, ipLockLogs, seatOrgs, seatUsers,
    ] = await Promise.all([
      supabaseAdmin.from('organizations').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('organizations').select('id', { count: 'exact', head: true }).eq('status', 'active'),
      supabaseAdmin.from('organizations').select('id', { count: 'exact', head: true }).eq('status', 'suspended'),
      supabaseAdmin.from('contracts').select('id', { count: 'exact', head: true })
        .eq('status', 'active').not('expires_at', 'is', null).lte('expires_at', in30).gte('expires_at', now.toISOString()),
      supabaseAdmin.from('users').select('id', { count: 'exact', head: true }).eq('is_super_admin', false),
      supabaseAdmin.from('users').select('id', { count: 'exact', head: true }).eq('is_super_admin', false).gte('created_at', monthStart),
      supabaseAdmin.from('usage_logs').select('user_id', { count: 'exact', head: true }).eq('action', 'chat_message').gte('created_at', todayStart),
      pagedRows<{ details: any }>((a, b, w) => supabaseAdmin.from('usage_logs').select('details', w ? { count: 'exact' } : undefined).eq('action', 'chat_message').gte('created_at', todayStart).order('id').range(a, b)),
      pagedRows<{ details: any }>((a, b, w) => supabaseAdmin.from('usage_logs').select('details', w ? { count: 'exact' } : undefined).eq('action', 'chat_message').gte('created_at', monthStart).order('id').range(a, b)),
      // 매출 — 그달에 유효했던 계약(2026-11-17, `contract-revenue.ts`). 예전엔 이번 달에 '시작한' 계약만 더해 이어지는 계약이 0원이었다
      supabaseAdmin.from('contracts').select('status, price_per_month, started_at, expires_at, updated_at').in('status', ['active', 'cancelled']).lt('started_at', nextMonthStart),
      // 80~100% 경고 기관 — 기관별 이번 달 토큰은 한 번만 읽는다(예전엔 경고·초과·Top 5가 같은 기록을 세 번 읽었다, 2026-11-17)
      (async () => {
        const { data: orgs } = await supabaseAdmin.from('organizations').select('id, monthly_token_limit').eq('status', 'active');
        const usageMap = (await monthTokensP) ?? new Map<string, number>();
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
        const usageMap = (await monthTokensP) ?? new Map<string, number>();
        return (orgs ?? []).filter((o: { id: string; monthly_token_limit?: number }) => o.monthly_token_limit && (usageMap.get(o.id) ?? 0) >= o.monthly_token_limit).length;
      })(),
      supabaseAdmin.from('organizations').select('id, name, plan, status, created_at').order('created_at', { ascending: false }).limit(5),
      supabaseAdmin.from('system_logs').select('level, message, created_at').in('level', ['error', 'critical']).order('created_at', { ascending: false }).limit(5),
      // 최근 24시간 critical — 문구별로 세어 알림 띠에(2026-11-17). 수는 정확히, 문구 묶기는 500줄까지
      supabaseAdmin.from('system_logs').select('message', { count: 'exact' }).eq('level', 'critical')
        .gte('created_at', new Date(Date.now() - CRITICAL_WINDOW_MS).toISOString()).order('created_at', { ascending: false }).limit(500),
      // 지금 로그인이 막힌 IP(2026-11-17) — 30분 창 안 실패의 IP 해시에서 30번 넘은 것. 기관 전체가 바깥 IP 하나를 쓰면 기관 전체가 막힌다
      // API는 한 번에 1,000행까지라 쪽마다 끝까지(pagedRows) — 무작위 대입이 몰리면 30분에 수천 줄이 된다
      pagedRows<{ ip_hash: string | null }>((a, b, w) => supabaseAdmin.from('sign_in_failures').select('ip_hash', w ? { count: 'exact' } : undefined).not('ip_hash', 'is', null)
        .gte('created_at', new Date(Date.now() - LOCK_WINDOW_MS).toISOString()).order('id').range(a, b)),
      // 그 사이 '막 잠김' 기록의 가린 IP(운영자가 기관 담당자에게 물을 단서)
      supabaseAdmin.from('system_logs').select('details, created_at').eq('message', IP_LOCK_STARTED)
        .gte('created_at', new Date(Date.now() - LOCK_WINDOW_MS).toISOString()).order('created_at', { ascending: false }).limit(20),
      // 사용자 수 상한에 가깝거나 닿은 기관(2026-11-17) — 상한 판정(`checkUserSeats`)과 같이 활성·탈퇴 안 한 계정을 기관별로
      supabaseAdmin.from('organizations').select('id, name, max_users').eq('status', 'active'),
      pagedRows<{ departments: { organization_id: string | null } | Array<{ organization_id: string | null }> | null }>((a, b, w) => supabaseAdmin
        .from('users').select('departments!inner(organization_id)', w ? { count: 'exact' } : undefined)
        .eq('is_active', true).is('deleted_at', null).order('id').range(a, b)),
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
    const estimatedCostUsd = estimateCostUsd({ input_tokens: monthInput, output_tokens: monthOutput });

    // ── 매출 집계 ──────────────────────────────────────
    const revenueRows = (revenueContracts.data ?? []) as RevenueContract[];
    const thisMonthRevenue = revenueIn(revenueRows, Date.parse(monthStart), Date.parse(nextMonthStart)).revenue;
    const lastMonthRevenue = revenueIn(revenueRows, Date.parse(lastMonthStart), Date.parse(monthStart)).revenue;
    const growthPercent    = lastMonthRevenue === 0 ? null : Math.round(((thisMonthRevenue - lastMonthRevenue) / lastMonthRevenue) * 100);

    // ── 최근 30일 일별 대화수 ──────────────────────────
    const { data: dailyLogs } = await pagedRows<{ created_at: string }>((a, b, w) => supabaseAdmin
      .from('usage_logs').select('created_at', w ? { count: 'exact' } : undefined).eq('action', 'chat_message')
      .gte('created_at', kstDayStart(addKstDays(kstDay(now), -29)).toISOString())
      .order('id').range(a, b));

    const dailyMap = new Map<string, number>();
    for (const l of dailyLogs ?? []) {
      const d = kstDay(l.created_at);
      dailyMap.set(d, (dailyMap.get(d) ?? 0) + 1);
    }
    const dailyChart: { date: string; count: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = addKstDays(kstDay(now), -i);
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
    const topMap = (await monthTokensP) ?? new Map<string, number>();
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
          // 못 읽으면 null(0으로 보이면 '문제 없음'으로 읽힌다)
          critical24h: criticalRecent.error ? null : { count: criticalRecent.count ?? 0, top: criticalSummary((criticalRecent.data ?? []) as Array<{ message: string | null }>) },
          // 못 읽으면 null(0으로 보이면 '막힌 곳 없음'으로 읽힌다)
          // 못 읽으면 null
          seats: seatOrgs.error || seatUsers.error ? null : seatAlerts(
            (seatOrgs.data ?? []) as Array<{ id: string; name: string | null; max_users: unknown }>,
            (seatUsers.data ?? []).map((u: { departments: { organization_id: string | null } | Array<{ organization_id: string | null }> | null }) => (Array.isArray(u.departments) ? u.departments[0]?.organization_id : u.departments?.organization_id)),
          ),
          lockedIps: ipFailures.error ? null : {
            count: lockedIpCount(((ipFailures.data ?? []) as Array<{ ip_hash: string | null }>).map((r) => r.ip_hash)),
            masked: Array.from(new Set(((ipLockLogs.data ?? []) as Array<{ details: { ip?: unknown } | null }>).map((r) => r.details?.ip).filter((v): v is string => typeof v === 'string'))).slice(0, 5),
          },
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
    return NextResponse.json({ ok: false, error: dbErrorText(err) }, { status: 500 });
  }
}
