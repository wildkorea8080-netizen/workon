import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getManagedDepartmentIds } from '@/lib/department-scope';

export const dynamic = 'force-dynamic';

/**
 * 직원 정보 수정 — 부서 이동, 권한 변경.
 *
 * 관리 범위는 관리자의 부서와 그 하위 부서입니다.
 * 대상 직원과 옮길 부서가 **모두** 이 범위 안에 있어야 합니다.
 * 한쪽만 검사하면 범위 밖 직원을 끌어오거나, 관리 밖 부서로 밀어낼 수 있습니다.
 */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json(
        { ok: false, error: { message: '관리자 권한이 필요합니다.' } },
        { status: 403 }
      );
    }

    const adminDeptId = session.user.departmentId;
    if (!adminDeptId) {
      return NextResponse.json(
        { ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } },
        { status: 403 }
      );
    }

    const managedDeptIds = await getManagedDepartmentIds(adminDeptId);

    // 대상 직원이 관리 범위 안인지
    const { data: target } = await supabaseAdmin
      .from('users')
      .select('id, department_id, role')
      .eq('id', params.id)
      .maybeSingle();

    if (!target || !target.department_id || !managedDeptIds.includes(target.department_id)) {
      return NextResponse.json(
        { ok: false, error: { message: '관리 권한이 없는 직원입니다.' } },
        { status: 403 }
      );
    }

    const body = await request.json();
    const update: Record<string, unknown> = {};

    if (body.department_id !== undefined) {
      const newDeptId = typeof body.department_id === 'string' ? body.department_id : '';
      if (!newDeptId) {
        return NextResponse.json(
          { ok: false, error: { message: '옮길 부서를 지정해주세요.' } },
          { status: 400 }
        );
      }
      if (!managedDeptIds.includes(newDeptId)) {
        return NextResponse.json(
          { ok: false, error: { message: '관리 범위 밖의 부서로는 옮길 수 없습니다.' } },
          { status: 403 }
        );
      }
      update.department_id = newDeptId;
    }

    if (body.role !== undefined) {
      const role = String(body.role).toUpperCase();
      if (!['ADMIN', 'USER'].includes(role)) {
        return NextResponse.json(
          { ok: false, error: { message: '권한은 ADMIN 또는 USER만 가능합니다.' } },
          { status: 400 }
        );
      }
      // 자기 자신의 권한을 낮춰 관리자가 한 명도 없는 상태가 되는 것을 막는다
      if (params.id === session.user.id && role !== 'ADMIN') {
        return NextResponse.json(
          { ok: false, error: { message: '본인의 관리자 권한은 해제할 수 없습니다.' } },
          { status: 400 }
        );
      }
      update.role = role;
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json(
        { ok: false, error: { message: '변경할 내용이 없습니다.' } },
        { status: 400 }
      );
    }

    const { data: updated, error } = await supabaseAdmin
      .from('users')
      .update(update)
      .eq('id', params.id)
      .select('id, email, full_name, role, department_id, created_at, departments(id, name)')
      .single();

    if (error) {
      console.error('[users PATCH]', error);
      return NextResponse.json(
        { ok: false, error: { message: '직원 정보 수정에 실패했습니다.' } },
        { status: 500 }
      );
    }

    const dept = Array.isArray((updated as any).departments)
      ? (updated as any).departments[0]
      : (updated as any).departments;

    return NextResponse.json({
      ok: true,
      data: { ...updated, departments: undefined, department_name: dept?.name ?? null },
    });
  } catch (error) {
    console.error('[users PATCH] 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
