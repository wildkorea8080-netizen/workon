import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function GET(_request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: { message: '인증이 필요합니다.' } },
        { status: 401 }
      );
    }

    const userId = session.user.id;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const [
      { data: recentConvs },
      { data: agentRows },
      { count: monthlyCount },
    ] = await Promise.all([
      // 최근 대화 3개
      supabaseAdmin
        .from('conversations')
        .select('id, title, created_at, updated_at, agent:agents(id, name)')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .limit(3),

      // 이 사용자가 사용한 에이전트 목록 (중복 제거)
      supabaseAdmin
        .from('conversations')
        .select('agent:agents(id, name, description)')
        .eq('user_id', userId)
        .not('agent_id', 'is', null),

      // 이번 달 사용 횟수 (usage_logs)
      supabaseAdmin
        .from('usage_logs')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('created_at', monthStart),
    ]);

    // 에이전트 중복 제거
    const agentMap = new Map<string, { id: string; name: string; description: string | null }>();
    for (const row of agentRows ?? []) {
      const agent = (row as any).agent;
      if (agent?.id && !agentMap.has(agent.id)) {
        agentMap.set(agent.id, agent);
      }
    }

    return NextResponse.json({
      ok: true,
      data: {
        recentConversations: recentConvs ?? [],
        usedAgents: Array.from(agentMap.values()),
        monthlyUsageCount: monthlyCount ?? 0,
      },
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
