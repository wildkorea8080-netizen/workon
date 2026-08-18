import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { estimateCostUsd } from '@/lib/models';

export const dynamic = 'force-dynamic';

function getPeriodRange(period: string, startDate?: string, endDate?: string) {
  const now = new Date();
  switch (period) {
    case 'today':
      return { start: new Date(now.getFullYear(), now.getMonth(), now.getDate()), end: now };
    case 'week':
      return { start: new Date(now.getTime() - 6 * 86400000), end: now };
    case 'custom':
      return {
        start: startDate ? new Date(startDate) : new Date(now.getTime() - 30 * 86400000),
        end:   endDate   ? new Date(endDate)   : now,
      };
    default: // month
      return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: now };
  }
}

export async function GET(request: NextRequest) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const period    = searchParams.get('period')    ?? 'month';
  const startDate = searchParams.get('startDate') ?? undefined;
  const endDate   = searchParams.get('endDate')   ?? undefined;
  const orgId     = searchParams.get('orgId')     ?? 'all';

  const { start, end } = getPeriodRange(period, startDate, endDate);

  try {
    // 기관 목록 (한도 포함)
    const { data: orgs } = await supabaseAdmin
      .from('organizations')
      .select('id, name, plan, monthly_token_limit, status');
    type OrgRow = {
      id: string;
      name: string;
      plan: string;
      monthly_token_limit: number | null;
      status: string;
    };
    // 명시적 제네릭이 없으면 [키, 값] 배열이 유니온으로 추론돼 Map 값 타입이 {}가 된다
    const orgMap = new Map<string, OrgRow>((orgs ?? []).map((o: OrgRow) => [o.id, o]));

    // usage_logs 조회
    let query = supabaseAdmin
      .from('usage_logs')
      .select('organization_id, user_id, details, created_at')
      .eq('action', 'chat_message')
      .gte('created_at', start.toISOString())
      .lte('created_at', end.toISOString());

    if (orgId !== 'all') query = query.eq('organization_id', orgId);

    const { data: logs, error } = await query.order('created_at', { ascending: true });
    if (error) throw error;

    const rows = logs ?? [];

    // ── 집계 ────────────────────────────────────────────────
    let totalConversations = 0;
    let totalInput = 0;
    let totalOutput = 0;
    const activeUsers = new Set<string>();

    // 일별/시간별 맵
    const timeMap = new Map<string, { conversations: number; inputTokens: number; outputTokens: number; users: Set<string> }>();
    // 기관별 맵
    const orgUsageMap = new Map<string, { conversations: number; inputTokens: number; outputTokens: number; users: Set<string> }>();

    for (const row of rows) {
      const inp = (row.details?.input_tokens  as number) ?? 0;
      const out = (row.details?.output_tokens as number) ?? 0;
      totalConversations++;
      totalInput  += inp;
      totalOutput += out;
      if (row.user_id) activeUsers.add(row.user_id);

      // 시간 키
      const d = new Date(row.created_at);
      const key = period === 'today'
        ? String(d.getHours()).padStart(2, '0') + ':00'
        : d.toISOString().slice(0, 10);

      const t = timeMap.get(key) ?? { conversations: 0, inputTokens: 0, outputTokens: 0, users: new Set() };
      t.conversations++; t.inputTokens += inp; t.outputTokens += out;
      if (row.user_id) t.users.add(row.user_id);
      timeMap.set(key, t);

      // 기관별
      const oid = row.organization_id ?? '__unknown';
      const o = orgUsageMap.get(oid) ?? { conversations: 0, inputTokens: 0, outputTokens: 0, users: new Set() };
      o.conversations++; o.inputTokens += inp; o.outputTokens += out;
      if (row.user_id) o.users.add(row.user_id);
      orgUsageMap.set(oid, o);
    }

    // 일별/시간별 배열 (빈 구간 채우기)
    const timeStats: any[] = [];
    if (period === 'today') {
      for (let h = 0; h < 24; h++) {
        const k = String(h).padStart(2, '0') + ':00';
        const t = timeMap.get(k);
        timeStats.push({ hour: k, conversations: t?.conversations ?? 0, inputTokens: t?.inputTokens ?? 0, outputTokens: t?.outputTokens ?? 0, activeUsers: t?.users.size ?? 0 });
      }
    } else {
      const cursor = new Date(start);
      while (cursor <= end) {
        const k = cursor.toISOString().slice(0, 10);
        const t = timeMap.get(k);
        timeStats.push({ date: k, conversations: t?.conversations ?? 0, inputTokens: t?.inputTokens ?? 0, outputTokens: t?.outputTokens ?? 0, activeUsers: t?.users.size ?? 0 });
        cursor.setDate(cursor.getDate() + 1);
      }
    }

    // 기관별 통계
    const orgStats = [...orgUsageMap.entries()]
      .map(([oid, u]) => {
        const org  = orgMap.get(oid);
        const limit = org?.monthly_token_limit ?? 0;
        const total = u.inputTokens + u.outputTokens;
        return {
          orgId: oid, orgName: org?.name ?? '알 수 없음', plan: org?.plan ?? '—',
          conversations: u.conversations, totalTokens: total,
          inputTokens: u.inputTokens, outputTokens: u.outputTokens,
          activeUsers: u.users.size,
          estimatedCost: estimateCostUsd({ input_tokens: u.inputTokens, output_tokens: u.outputTokens }),
          tokenLimit: limit,
          usagePercent: limit > 0 ? Math.round((total / limit) * 100) : 0,
        };
      })
      .sort((a, b) => b.totalTokens - a.totalTokens);

    const estimatedCostUsd = parseFloat(
      estimateCostUsd({ input_tokens: totalInput, output_tokens: totalOutput }).toFixed(4)
    );

    return NextResponse.json({
      ok: true,
      data: {
        summary: {
          totalConversations, totalInputTokens: totalInput, totalOutputTokens: totalOutput,
          totalActiveUsers: activeUsers.size, estimatedCostUsd,
        },
        timeStats,
        orgStats,
        period,
      },
    });
  } catch (err: any) {
    console.error('[super/usage GET]', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
