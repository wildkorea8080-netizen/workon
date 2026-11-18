import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { pagedRows } from '@/lib/paged-select';
import { addKstDays, kstDay, kstDayList, kstDayStart, kstMonthStart } from '@/lib/kst-time';
import { sumMyTokens } from '@/lib/my-usage-tokens';
import { myMonthlyBudget, myDepartmentBudget, type MyBudgetStatus } from '@/lib/usage-limit';

export const dynamic = 'force-dynamic';

type Period = 'week' | 'month' | 'last_month' | '3months';

/** 기간 — 한국 날짜 기준(서버는 UTC라 예전에는 '이번 달'이 1일 09:00 KST에 시작했다, 2026-11-06) */
function getPeriodRange(period: Period): { start: Date; end: Date } {
  const now = new Date();
  const today = kstDay(now);
  switch (period) {
    case 'week':
      return { start: kstDayStart(addKstDays(today, -6)), end: now };
    case 'last_month':
      return { start: kstMonthStart(now, -1), end: kstMonthStart(now, 0) };
    case '3months':
      return { start: kstDayStart(addKstDays(today, -89)), end: now };
    default: // month
      return { start: kstMonthStart(now, 0), end: now };
  }
}

// 못 읽었으면 0건·0토큰으로 보이지 않는다(2026-11-18)
function unavailable() {
  return NextResponse.json(
    { ok: false, error: { message: '사용 현황을 지금 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' } },
    { status: 503 }
  );
}

export async function GET(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: { message: '인증이 필요합니다.' } },
        { status: 401 }
      );
    }

    const userId = session.user.id;
    const { searchParams } = new URL(request.url);
    const period = (searchParams.get('period') ?? 'month') as Period;
    const { start: periodStart, end: periodEnd } = getPeriodRange(period);

    // 1) 기간 내 대화 (agent 정보 포함)
    // 쪽마다 끝까지 — API는 한 번에 1,000행까지만 돌려준다(2026-11-05)
    const { data: periodConvs, error: periodError } = await pagedRows<any>((a, b, w) => supabaseAdmin
      .from('conversations')
      .select('id, agent_id, title, created_at, agents(name, icon)', w ? { count: 'exact' } : undefined)
      .eq('user_id', userId)
      .gte('created_at', periodStart.toISOString())
      .lte('created_at', periodEnd.toISOString())
      .order('created_at', { ascending: true })
      .order('id')
      .range(a, b));
    if (periodError) return unavailable();

    const convs = periodConvs ?? [];

    // 2) 토큰 — 기록한 실제 사용량(`usage_logs`). 예전엔 메시지 글자 수 ÷ 4로 어림해 실제의 몇 분의 일로 보였다(2026-11-18, `my-usage-tokens.ts`)
    const now = new Date();
    const thisMonthStart = kstMonthStart(now, 0);
    const usageFrom = new Date(Math.min(periodStart.getTime(), thisMonthStart.getTime()));
    const { data: usageRows, error: usageError } = await pagedRows<{ details: unknown; created_at: string }>((a, b, w) => supabaseAdmin
      .from('usage_logs')
      .select('details, created_at', w ? { count: 'exact' } : undefined)
      .eq('user_id', userId)
      .gte('created_at', usageFrom.toISOString())
      .order('id')
      .range(a, b));
    if (usageError) return unavailable();
    const tokens = sumMyTokens(usageRows ?? [], {
      monthStartMs: thisMonthStart.getTime(),
      periodStartMs: periodStart.getTime(),
      periodEndMs: periodEnd.getTime(),
    });

    // 3) 이번달 전체 대화 수 (summary 카드용 — 기간 필터와 무관)
    const { data: thisMonthConvs, error: monthError } = await pagedRows<{ id: string }>((a, b, w) => supabaseAdmin
      .from('conversations')
      .select('id', w ? { count: 'exact' } : undefined)
      .eq('user_id', userId)
      .gte('created_at', thisMonthStart.toISOString())
      .order('id')
      .range(a, b));

    if (monthError) return unavailable();
    const thisMonthIds = (thisMonthConvs ?? []).map((c: { id: string }) => c.id);

    // 4) 연속 사용일 (전체 기간)
    const { data: allConvDates, error: datesError } = await pagedRows<{ created_at: string }>((a, b, w) => supabaseAdmin
      .from('conversations')
      .select('created_at', w ? { count: 'exact' } : undefined)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .order('id')
      .range(a, b));
    if (datesError) return unavailable();

    const dateSet = new Set<string>();
    for (const c of allConvDates ?? []) {
      dateSet.add(kstDay(c.created_at));
    }
    const todayStr = kstDay(now);
    let streakDays = 0;
    for (let i = 0; i < 365; i++) {
      const ds = addKstDays(todayStr, -i);
      if (dateSet.has(ds)) {
        streakDays++;
      } else if (ds === todayStr) {
        // 오늘 아직 대화 없어도 연속 유지 (어제부터 카운트)
        continue;
      } else {
        break;
      }
    }

    // 5) 개인 월 한도 — 한도 알림 메일이 이 화면으로 보낸다(2026-11-18). 못 읽으면 0원으로 꾸미지 않고 '확인하지 못함'
    let budget: MyBudgetStatus | null = null;
    let budgetUnknown = false;
    try {
      budget = await myMonthlyBudget(userId);
    } catch {
      budgetUnknown = true;
    }

    // 5-2) 부서 월 한도 — 닿으면 부서 직원 전체가 멈추는데 볼 곳이 없었다(2026-11-18). 못 읽으면 '확인하지 못함'
    let departmentBudget: MyBudgetStatus | null = null;
    let departmentBudgetUnknown = false;
    try {
      departmentBudget = await myDepartmentBudget(userId);
    } catch {
      departmentBudgetUnknown = true;
    }

    // ── 집계 ──────────────────────────────────────────────

    // 일별 차트 (기간 내 모든 날짜 포함)
    const dailyMap = new Map<string, number>();
    for (const c of convs) {
      const d = kstDay(c.created_at);
      dailyMap.set(d, (dailyMap.get(d) ?? 0) + 1);
    }
    // 한국 날짜로 빈 날도 채운다 — 끝은 기간 끝 바로 앞 순간의 날(지난달이면 그 달 말일)
    const dailyChart = kstDayList(kstDay(periodStart), kstDay(periodEnd.getTime() - 1)).map((date) => ({ date, count: dailyMap.get(date) ?? 0 }));

    // 비서별 통계
    const agentMap = new Map<
      string,
      { name: string; icon?: string; convCount: number; tokens: number; lastUsed: string }
    >();
    for (const c of convs) {
      if (!c.agent_id) continue;
      const agentInfo = (c as { agents?: { name?: string; icon?: string } | null }).agents;
      const existing = agentMap.get(c.agent_id);
      if (existing) {
        existing.convCount++;
        if (c.created_at > existing.lastUsed) existing.lastUsed = c.created_at;
      } else {
        agentMap.set(c.agent_id, {
          name: agentInfo?.name ?? '알 수 없음',
          icon: agentInfo?.icon ?? undefined,
          convCount: 1,
          // 이 기간에 그 비서로 쓴 토큰(기록 기준)
          tokens: tokens.byAgent.get(c.agent_id) ?? 0,
          lastUsed: c.created_at,
        });
      }
    }

    const agentStats = Array.from(agentMap.entries())
      .map(([agentId, s]) => ({ agentId, ...s }))
      .sort((a, b) => b.convCount - a.convCount);

    // 최근 5개 대화
    const recentConversations = [...convs]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 5)
      .map((c) => {
        const agentInfo = (c as { agents?: { name?: string; icon?: string } | null }).agents;
        return {
          id: c.id,
          title: c.title ?? '(제목 없음)',
          agentName: agentInfo?.name ?? null,
          agentIcon: agentInfo?.icon ?? null,
          createdAt: c.created_at,
        };
      });

    return NextResponse.json({
      ok: true,
      data: {
        summary: {
          monthlyConvCount: thisMonthIds.length,
          monthlyTokens: tokens.monthly,
          topAgent: agentStats[0] ?? null,
          streakDays,
          budget,
          budgetUnknown,
          departmentBudget,
          departmentBudgetUnknown,
        },
        dailyChart,
        agentStats,
        recentConversations,
      },
    });
  } catch (error) {
    console.error('[my/stats GET]', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
