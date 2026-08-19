import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const search  = searchParams.get('search') ?? '';
  const orgId   = searchParams.get('orgId')  ?? '';
  const role    = searchParams.get('role')   ?? 'all';
  const page    = Math.max(1, parseInt(searchParams.get('page')  ?? '1'));
  const limit   = Math.min(100, parseInt(searchParams.get('limit') ?? '30'));

  try {
    // 1) 부서 → 기관 맵 구성
    const { data: depts } = await supabaseAdmin
      .from('departments')
      .select('id, name, organization_id');

    const { data: orgs } = await supabaseAdmin
      .from('organizations')
      .select('id, name');

    const orgMap = Object.fromEntries((orgs ?? []).map((o: { id: string; name: string }) => [o.id, o.name]));
    const deptMap = Object.fromEntries(
      (depts ?? []).map((d: { id: string; name: string; organization_id: string }) => [d.id, { deptName: d.name, orgId: d.organization_id, orgName: orgMap[d.organization_id] ?? '' }])
    );

    // 2) 특정 기관 필터: 해당 기관 부서 ID 목록
    const deptFilter: string[] | null = orgId
      ? (depts ?? [])
          .filter((d: { organization_id: string }) => d.organization_id === orgId)
          .map((d: { id: string }) => d.id)
      : null;

    // 해당 기관에 부서가 하나도 없으면 조회 결과도 비어 있다
    if (deptFilter && deptFilter.length === 0) {
      return NextResponse.json({ ok: true, data: [], meta: { total: 0, page, limit } });
    }

    // 3) 사용자 쿼리
    let query = supabaseAdmin
      .from('users')
      .select('id, email, full_name, role, department_id, is_super_admin, created_at, updated_at, position', { count: 'exact' })
      .eq('is_super_admin', false); // 슈퍼관리자는 별도 탭에서 관리

    if (search)      query = query.or(`email.ilike.%${search}%,full_name.ilike.%${search}%`);
    if (role !== 'all') query = query.eq('role', role);
    if (deptFilter)  query = query.in('department_id', deptFilter);

    const { data: users, count, error } = await query
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (error) throw error;

    // is_active 컬럼이 없을 경우 대비 안전 처리
    const enriched = (users ?? []).map((u: any) => ({
      ...u,
      is_active: u.is_active ?? true,
      department_name: deptMap[u.department_id]?.deptName ?? '—',
      organization_name: deptMap[u.department_id]?.orgName ?? '—',
    }));

    // 통계
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const { count: newThisMonth } = await supabaseAdmin
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('is_super_admin', false)
      .gte('created_at', monthStart);

    return NextResponse.json({
      ok: true,
      data: enriched,
      meta: { total: count ?? 0, page, limit, newThisMonth: newThisMonth ?? 0 },
    });
  } catch (err: any) {
    console.error('[super/accounts/users GET]', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
