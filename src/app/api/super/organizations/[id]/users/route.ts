import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { pagedRows } from '@/lib/paged-select';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  try {
    const { searchParams } = new URL(request.url);
    const search = searchParams.get('search') ?? '';

    // 기관 소속 부서 ID 목록
    const { data: depts } = await supabaseAdmin
      .from('departments')
      .select('id, name')
      .eq('organization_id', params.id);

    if (!depts?.length) return NextResponse.json({ ok: true, data: [] });

    const deptIds = depts.map((d: { id: string }) => d.id);
    const deptNameMap = Object.fromEntries(depts.map((d: { id: string; name: string }) => [d.id, d.name]));

    // 기관 직원이 1,000명을 넘어도 잘리지 않게 쪽마다 끝까지
    const pageOf = (a: number, b: number, w: boolean) => {
      let q = supabaseAdmin
        .from('users')
        .select('id, email, full_name, role, position, department_id, created_at, updated_at, is_super_admin', w ? { count: 'exact' } : undefined)
        .in('department_id', deptIds)
        .is('deleted_at', null) // 삭제(탈퇴)한 계정은 행만 남아 있다 (0047)
        .order('created_at', { ascending: false })
        .order('id');
      if (search) q = q.or(`email.ilike.%${search}%,full_name.ilike.%${search}%`);
      return q.range(a, b);
    };

    const { data: users, error } = await pagedRows<any>(pageOf);
    if (error) throw error;

    const enriched = (users ?? []).map((u: any) => ({
      ...u,
      department_name: u.department_id ? (deptNameMap[u.department_id] ?? '—') : '—',
    }));

    return NextResponse.json({ ok: true, data: enriched });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
