import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { pagedRows } from '@/lib/paged-select';

export const dynamic = 'force-dynamic';

type Period = 'week' | 'month' | 'last_month' | '3months';

function getPeriodRange(period: Period): { start: Date; end: Date } {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (period) {
    case 'week':
      return {
        start: new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000),
        end: now,
      };
    case 'last_month': {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start, end };
    }
    case '3months':
      return {
        start: new Date(todayStart.getTime() - 89 * 24 * 60 * 60 * 1000),
        end: now,
      };
    default: // month
      return {
        start: new Date(now.getFullYear(), now.getMonth(), 1),
        end: now,
      };
  }
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
    const { data: periodConvs } = await pagedRows<any>((a, b, w) => supabaseAdmin
      .from('conversations')
      .select('id, agent_id, title, created_at, agents(name, icon)', w ? { count: 'exact' } : undefined)
      .eq('user_id', userId)
      .gte('created_at', periodStart.toISOString())
      .lte('created_at', periodEnd.toISOString())
      .order('created_at', { ascending: true })
      .order('id')
      .range(a, b));

    const convs = periodConvs ?? [];
    const convIds = convs.map((c: { id: string }) => c.id);

    // 2) 기간 내 메시지 (토큰 추정용)
    let msgData: { conversation_id: string; content: string }[] = [];
    if (convIds.length > 0) {
      // 대화 id 목록을 in()으로 넘기면 주소가 길어지고 1,000행에서 잘린다 — 대화를 끼워 걸러 쪽마다 끝까지
      const { data: msgs } = await pagedRows<{ conversation_id: string; content: string }>((a, b, w) => supabaseAdmin
        .from('messages')
        .select('conversation_id, content, conversation:conversations!inner(user_id, created_at)', w ? { count: 'exact' } : undefined)
        .eq('conversation.user_id', userId)
        .gte('conversation.created_at', periodStart.toISOString())
        .lte('conversation.created_at', periodEnd.toISOString())
        .in('role', ['user', 'assistant'])
        .order('id')
        .range(a, b));
      msgData = (msgs ?? []).map((m) => ({ conversation_id: m.conversation_id, content: m.content }));
    }

    // 3) 이번달 전체 대화 수 + 토큰 (summary 카드용 — 기간 필터와 무관)
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const { data: thisMonthConvs } = await pagedRows<{ id: string }>((a, b, w) => supabaseAdmin
      .from('conversations')
      .select('id', w ? { count: 'exact' } : undefined)
      .eq('user_id', userId)
      .gte('created_at', thisMonthStart.toISOString())
      .order('id')
      .range(a, b));

    const thisMonthIds = (thisMonthConvs ?? []).map((c: { id: string }) => c.id);
    let monthlyTokenEstimate = 0;
    if (thisMonthIds.length > 0) {
      const { data: monthMsgs } = await pagedRows<{ content: string }>((a, b, w) => supabaseAdmin
        .from('messages')
        .select('content, conversation:conversations!inner(user_id, created_at)', w ? { count: 'exact' } : undefined)
        .eq('conversation.user_id', userId)
        .gte('conversation.created_at', thisMonthStart.toISOString())
        .in('role', ['user', 'assistant'])
        .order('id')
        .range(a, b));
      monthlyTokenEstimate = (monthMsgs ?? []).reduce(
        (sum: number, m: { content: string }) => sum + Math.ceil(m.content.length / 4),
        0
      );
    }

    // 4) 연속 사용일 (전체 기간)
    const { data: allConvDates } = await pagedRows<{ created_at: string }>((a, b, w) => supabaseAdmin
      .from('conversations')
      .select('created_at', w ? { count: 'exact' } : undefined)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .order('id')
      .range(a, b));

    const dateSet = new Set<string>();
    for (const c of allConvDates ?? []) {
      dateSet.add(c.created_at.slice(0, 10));
    }
    const todayStr = now.toISOString().slice(0, 10);
    let streakDays = 0;
    for (let i = 0; i < 365; i++) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const ds = d.toISOString().slice(0, 10);
      if (dateSet.has(ds)) {
        streakDays++;
      } else if (ds === todayStr) {
        // 오늘 아직 대화 없어도 연속 유지 (어제부터 카운트)
        continue;
      } else {
        break;
      }
    }

    // ── 집계 ──────────────────────────────────────────────

    // 대화당 토큰 추정
    const tokenByConv = new Map<string, number>();
    for (const m of msgData) {
      tokenByConv.set(
        m.conversation_id,
        (tokenByConv.get(m.conversation_id) ?? 0) + Math.ceil(m.content.length / 4)
      );
    }

    // 일별 차트 (기간 내 모든 날짜 포함)
    const dailyMap = new Map<string, number>();
    for (const c of convs) {
      const d = c.created_at.slice(0, 10);
      dailyMap.set(d, (dailyMap.get(d) ?? 0) + 1);
    }
    const dailyChart: { date: string; count: number }[] = [];
    const cursor = new Date(periodStart.getFullYear(), periodStart.getMonth(), periodStart.getDate());
    while (cursor <= periodEnd) {
      const ds = cursor.toISOString().slice(0, 10);
      dailyChart.push({ date: ds, count: dailyMap.get(ds) ?? 0 });
      cursor.setDate(cursor.getDate() + 1);
    }

    // 비서별 통계
    const agentMap = new Map<
      string,
      { name: string; icon?: string; convCount: number; tokenEstimate: number; lastUsed: string }
    >();
    for (const c of convs) {
      if (!c.agent_id) continue;
      const agentInfo = (c as { agents?: { name?: string; icon?: string } | null }).agents;
      const tokens = tokenByConv.get(c.id) ?? 0;
      const existing = agentMap.get(c.agent_id);
      if (existing) {
        existing.convCount++;
        existing.tokenEstimate += tokens;
        if (c.created_at > existing.lastUsed) existing.lastUsed = c.created_at;
      } else {
        agentMap.set(c.agent_id, {
          name: agentInfo?.name ?? '알 수 없음',
          icon: agentInfo?.icon ?? undefined,
          convCount: 1,
          tokenEstimate: tokens,
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
          monthlyTokenEstimate,
          topAgent: agentStats[0] ?? null,
          streakDays,
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
