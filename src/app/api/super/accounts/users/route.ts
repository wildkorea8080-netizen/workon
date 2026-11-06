import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { kstMonthStart } from '@/lib/kst-time';
import { pagedRows } from '@/lib/paged-select';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const search  = searchParams.get('search') ?? '';
  const orgId   = searchParams.get('orgId')  ?? '';
  const role    = searchParams.get('role')   ?? 'all';
  // 숫자가 아니면 범위 조회가 깨진다 — 쪽 1 이상, 쪽 크기 1~100
  const rawPage  = parseInt(searchParams.get('page')  ?? '1', 10);
  const rawLimit = parseInt(searchParams.get('limit') ?? '30', 10);
  const page    = Number.isFinite(rawPage) ? Math.max(1, rawPage) : 1;
  const limit   = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 30;

  try {
    // 1) 부서 → 기관 맵 구성
    // 모든 기관의 부서·기관을 쪽마다 끝까지 — 한 번에 읽으면 1,000행에서 조용히 잘려, 뒤 부서의 이름이 '—'가 되고
    // 기관으로 거를 때 그 기관 부서가 빠져 직원이 목록에서 사라졌다(2026-11-06)
    const [{ data: depts, error: deptError }, { data: orgs, error: orgError }] = await Promise.all([
      pagedRows<{ id: string; name: string; organization_id: string }>((a, b, w) => supabaseAdmin
        .from('departments').select('id, name, organization_id', w ? { count: 'exact' } : undefined).order('id').range(a, b)),
      pagedRows<{ id: string; name: string }>((a, b, w) => supabaseAdmin
        .from('organizations').select('id, name', w ? { count: 'exact' } : undefined).order('id').range(a, b)),
    ]);
    if (deptError || orgError) throw new Error((deptError ?? orgError)!.message);

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
      .select('id, email, full_name, role, department_id, is_super_admin, is_active, created_at, updated_at, position', { count: 'exact' })
      .eq('is_super_admin', false) // 슈퍼관리자는 별도 탭에서 관리
      .is('deleted_at', null);     // 삭제(탈퇴)한 계정은 행만 남아 있다 (0047)

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
    const monthStart = kstMonthStart(now, 0).toISOString();
    const { count: newThisMonth } = await supabaseAdmin
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('is_super_admin', false)
      .is('deleted_at', null)
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
