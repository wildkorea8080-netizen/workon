import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

function getPeriodStart(period: string, startDate?: string): Date {
  const now = new Date();
  if (period === 'custom' && startDate) return new Date(startDate);
  switch (period) {
    case 'today': return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    case 'week':  return new Date(now.getTime() - 6 * 86400000);
    default:      return new Date(now.getFullYear(), now.getMonth(), 1);
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
  const end   = endDate ? new Date(endDate) : new Date();

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
