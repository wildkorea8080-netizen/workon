import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const sp       = new URL(request.url).searchParams;
  const level    = sp.get('level')    ?? 'all';
  const category = sp.get('category') ?? 'all';
  const period   = sp.get('period')   ?? 'month';
  const page     = Math.max(1, parseInt(sp.get('page')  ?? '1'));
  const limit    = Math.min(200, parseInt(sp.get('limit') ?? '50'));

  const now = new Date();
  const start = period === 'today' ? new Date(now.getFullYear(), now.getMonth(), now.getDate())
    : period === 'week' ? new Date(now.getTime() - 6 * 86400000)
    : new Date(now.getFullYear(), now.getMonth(), 1);

  try {
    let query = supabaseAdmin
      .from('system_logs')
      .select('*, organizations(id, name)', { count: 'exact' })
      .gte('created_at', start.toISOString())
      .order('created_at', { ascending: false });

    if (level    !== 'all') query = query.eq('level', level);
    if (category !== 'all') query = query.eq('category', category);

    const { data, count, error } = await query.range((page - 1) * limit, page * limit - 1);
    if (error) throw error;

    // 에러 요약 (오늘 + 이번주)
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekStart  = new Date(now.getTime() - 6 * 86400000).toISOString();

    const [todayCount, weekCount, prevWeekCount] = await Promise.all([
      supabaseAdmin.from('system_logs').select('level', { count: 'exact', head: true })
        .in('level', ['error', 'critical']).gte('created_at', todayStart),
      supabaseAdmin.from('system_logs').select('level', { count: 'exact', head: true })
        .in('level', ['error', 'critical']).gte('created_at', weekStart),
      supabaseAdmin.from('system_logs').select('level', { count: 'exact', head: true })
        .in('level', ['error', 'critical'])
        .gte('created_at', new Date(now.getTime() - 13 * 86400000).toISOString())
        .lt('created_at', weekStart),
    ]);

    const todayErrors   = todayCount.count  ?? 0;
    const weekErrors    = weekCount.count   ?? 0;
    const prevWeekErrors = prevWeekCount.count ?? 0;
    const weekTrend = prevWeekErrors === 0 ? null
      : Math.round(((weekErrors - prevWeekErrors) / prevWeekErrors) * 100);

    return NextResponse.json({
      ok: true,
      data: data ?? [],
      meta: { total: count ?? 0, page, limit },
      summary: { todayErrors, weekErrors, weekTrend },
    });
  } catch (err: any) {
    console.warn('[super/logs/system GET]', err.message);
    return NextResponse.json({ ok: true, data: [], meta: { total: 0, page, limit }, summary: { todayErrors: 0, weekErrors: 0, weekTrend: null } });
  }
}
