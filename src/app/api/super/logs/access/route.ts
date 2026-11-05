import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { addKstDays, kstDay, kstDayStart, kstMonthStart } from '@/lib/kst-time';

export const dynamic = 'force-dynamic';

function getPeriodStart(period: string, startDate?: string): Date {
  const now = new Date();
  // 고른 날짜는 한국 날짜 — 그날 한국 00:00부터(2026-11-06)
  if (period === 'custom' && startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) return kstDayStart(startDate);
  switch (period) {
    case 'today': return kstDayStart(kstDay(now));
    case 'week':  return new Date(now.getTime() - 6 * 86400000);
    default:      return kstMonthStart(now, 0);
  }
}

export async function GET(request: NextRequest) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const sp        = new URL(request.url).searchParams;
  const period    = sp.get('period')    ?? 'month';
  const startDate = sp.get('startDate') ?? undefined;
  const endDate   = sp.get('endDate')   ?? undefined;
  const orgId     = sp.get('orgId')     ?? '';
  const action    = sp.get('action')    ?? 'all';
  const search    = sp.get('search')    ?? '';
  const page      = Math.max(1, parseInt(sp.get('page')  ?? '1'));
  const limit     = Math.min(200, parseInt(sp.get('limit') ?? '50'));

  const start = getPeriodStart(period, startDate);
  // 끝 날은 그날 한국 23:59:59.999까지 — 예전에는 그날 UTC 0시로 읽어 끝 날 하루가 거의 다 빠졌다
  const end   = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? new Date(kstDayStart(addKstDays(endDate, 1)).getTime() - 1) : new Date();

  try {
    let query = supabaseAdmin
      .from('access_logs')
      .select(`
        id, action, path, ip_address, user_agent, status_code, details, created_at,
        users(id, email, full_name),
        organizations(id, name)
      `, { count: 'exact' })
      .gte('created_at', start.toISOString())
      .lte('created_at', end.toISOString())
      .order('created_at', { ascending: false });

    if (action !== 'all') query = query.eq('action', action);
    if (orgId)            query = query.eq('org_id', orgId);

    const { data, count, error } = await query.range((page - 1) * limit, page * limit - 1);
    if (error) throw error;

    // 검색 필터 (클라이언트 사이드)
    let rows = (data ?? []) as any[];
    if (search) {
      const s = search.toLowerCase();
      rows = rows.filter(r =>
        r.users?.email?.toLowerCase().includes(s) ||
        r.users?.full_name?.toLowerCase().includes(s) ||
        r.ip_address?.includes(s)
      );
    }

    // 로그인 실패 패턴 감지 (동일 IP 5회 이상)
    const failLogs = rows.filter(r => r.action === 'login_failed');
    const ipFailMap = new Map<string, number>();
    for (const l of failLogs) {
      if (l.ip_address) ipFailMap.set(l.ip_address, (ipFailMap.get(l.ip_address) ?? 0) + 1);
    }
    const suspiciousIps = [...ipFailMap.entries()].filter(([, n]) => n >= 5)
      .map(([ip, count]) => ({ ip, count }));

    return NextResponse.json({
      ok: true,
      data: rows,
      meta: { total: count ?? 0, page, limit },
      suspiciousIps,
    });
  } catch (err: any) {
    // access_logs 테이블 없으면 빈 배열
    console.warn('[super/logs/access GET]', err.message);
    return NextResponse.json({ ok: true, data: [], meta: { total: 0, page, limit }, suspiciousIps: [] });
  }
}
