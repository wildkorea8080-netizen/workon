import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

function getPeriodStart(period: string): Date {
  const now = new Date();
  switch (period) {
    case 'last_month': return new Date(now.getFullYear(), now.getMonth() - 1, 1);
    case '3months':    return new Date(now.getFullYear(), now.getMonth() - 2, 1);
    case '6months':    return new Date(now.getFullYear(), now.getMonth() - 5, 1);
    default:           return new Date(now.getFullYear(), now.getMonth(), 1); // this month
  }
}

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const period = searchParams.get('period') ?? 'month';
  const start = getPeriodStart(period);

  try {
    // usage_logs에서 기간 내 chat_message 로그 조회
    const { data: logs, error } = await supabaseAdmin
      .from('usage_logs')
      .select('user_id, details, created_at')
      .eq('organization_id', params.id)
      .eq('action', 'chat_message')
      .gte('created_at', start.toISOString())
      .order('created_at', { ascending: true });

    if (error) throw error;

    const rows = logs ?? [];

    // 일별 집계
    const dailyMap = new Map<string, { conversations: number; inputTokens: number; outputTokens: number }>();
    const userTokenMap = new Map<string, number>();
    const activeUserSet = new Set<string>();

    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const row of rows) {
      const date = row.created_at.slice(0, 10);
      const inp  = (row.details?.input_tokens  as number) ?? 0;
      const out  = (row.details?.output_tokens as number) ?? 0;
      totalInputTokens  += inp;
      totalOutputTokens += out;

      const daily = dailyMap.get(date) ?? { conversations: 0, inputTokens: 0, outputTokens: 0 };
      daily.conversations++;
      daily.inputTokens  += inp;
      daily.outputTokens += out;
      dailyMap.set(date, daily);

      if (row.user_id) {
        activeUserSet.add(row.user_id);
        userTokenMap.set(row.user_id, (userTokenMap.get(row.user_id) ?? 0) + inp + out);
      }
    }

    // 일별 배열 (빈 날도 포함)
    const dailyChart: { date: string; conversations: number; inputTokens: number; outputTokens: number }[] = [];
    const cursor = new Date(start);
    const today  = new Date();
    while (cursor <= today) {
      const d = cursor.toISOString().slice(0, 10);
      const entry = dailyMap.get(d) ?? { conversations: 0, inputTokens: 0, outputTokens: 0 };
      dailyChart.push({ date: d, ...entry });
      cursor.setDate(cursor.getDate() + 1);
    }

    // Top 5 사용자 (user_id → name 조회)
    const topUserIds = [...userTokenMap.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => id);

    let topUsers: { userId: string; name: string; tokens: number }[] = [];
    if (topUserIds.length > 0) {
      const { data: userRows } = await supabaseAdmin
        .from('users').select('id, full_name, email').in('id', topUserIds);
      topUsers = topUserIds.map(id => {
        const u = (userRows ?? []).find(r => r.id === id);
        return { userId: id, name: u?.full_name || u?.email || id.slice(0, 8), tokens: userTokenMap.get(id) ?? 0 };
      });
    }

    // 예상 비용: input $3/M, output $15/M
    const costUsd = parseFloat(
      ((totalInputTokens / 1_000_000) * 3 + (totalOutputTokens / 1_000_000) * 15).toFixed(4)
    );

    return NextResponse.json({
      ok: true,
      data: {
        summary: {
          conversations: rows.length,
          totalTokens: totalInputTokens + totalOutputTokens,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          activeUsers: activeUserSet.size,
          costUsd,
        },
        dailyChart,
        topUsers,
      },
    });
  } catch (err: any) {
    console.error('[usage GET]', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
