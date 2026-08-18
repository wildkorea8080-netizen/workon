import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getSharedDepartmentIds, getManagedDepartmentIds } from '@/lib/department-scope';

export const dynamic = 'force-dynamic';

async function requireAdminOrg() {
  const session = await getServerAuthSession();
  if (!session?.user?.id || !isAdminSession(session)) {
    return { error: NextResponse.json({ ok: false, error: { message: '관리자 권한이 필요합니다.' } }, { status: 403 }) };
  }

  const departmentId = session.user.departmentId;
  if (!departmentId) {
    return { error: NextResponse.json({ ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } }, { status: 403 }) };
  }

  const { data } = await supabaseAdmin
    .from('departments')
    .select('organization_id')
    .eq('id', departmentId)
    .maybeSingle();

  const organizationId = data?.organization_id;
  if (!organizationId) {
    return { error: NextResponse.json({ ok: false, error: { message: '기관 정보를 찾을 수 없습니다.' } }, { status: 409 }) };
  }

  return { session, departmentId, organizationId };
}

/** 대상 부서가 관리자의 관리 범위(자기 부서 + 하위) 안인지 확인 */
async function loadDepartment(id: string, organizationId: string, managedIds: string[]) {
  if (!managedIds.includes(id)) return null;

  const { data } = await supabaseAdmin
    .from('departments')
    .select('id, name, parent_id')
    .eq('id', id)
    .eq('organization_id', organizationId)
    .maybeSingle();
  return data;
}

/** 부서 수정 — 이름 변경 / 상위 부서 이동 */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireAdminOrg();
  if ('error' in ctx) return ctx.error;

  const managedIds = await getManagedDepartmentIds(ctx.departmentId);
  const target = await loadDepartment(params.id, ctx.organizationId, managedIds);
  if (!target) {
    return NextResponse.json({ ok: false, error: { message: '부서를 찾을 수 없습니다.' } }, { status: 404 });
  }

  const body = await request.json();
  const update: Record<string, unknown> = {};

  if (typeof body.name === 'string') {
    const name = body.name.trim();
    if (!name) {
      return NextResponse.json({ ok: false, error: { message: '부서명을 입력해주세요.' } }, { status: 400 });
    }
    update.name = name;
  }

  if (body.parent_id !== undefined) {
    const parentId = typeof body.parent_id === 'string' && body.parent_id ? body.parent_id : null;

    if (parentId === target.id) {
      return NextResponse.json({ ok: false, error: { message: '자기 자신을 상위 부서로 지정할 수 없습니다.' } }, { status: 400 });
    }

    if (parentId) {
      const parent = await loadDepartment(parentId, ctx.organizationId, managedIds);
      if (!parent) {
        return NextResponse.json({ ok: false, error: { message: '상위 부서를 찾을 수 없습니다.' } }, { status: 400 });
      }

      // 순환 방지: 자기 하위 부서를 상위로 지정하면 트리가 끊어진 고리가 된다.
      // 그 부서들은 어떤 최상위에도 닿지 못해 화면에서 사라지고 조회도 무한루프에 빠진다.
      const descendants = await getSharedDepartmentIds(target.id);
      if (descendants.includes(parentId)) {
        return NextResponse.json(
          { ok: false, error: { message: '하위 부서를 상위 부서로 지정할 수 없습니다.' } },
          { status: 400 }
        );
      }
    }

    update.parent_id = parentId;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: false, error: { message: '변경할 내용이 없습니다.' } }, { status: 400 });
  }

  const { data: updated, error } = await supabaseAdmin
    .from('departments')
    .update(update)
    .eq('id', target.id)
    .eq('organization_id', ctx.organizationId)
    .select('id, name, parent_id, description')
    .single();

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ ok: false, error: { message: '같은 이름의 부서가 이미 있습니다.' } }, { status: 409 });
    }
    console.error('[departments PATCH]', error);
    return NextResponse.json({ ok: false, error: { message: '부서 수정에 실패했습니다.' } }, { status: 500 });
  }

  return NextResponse.json({ ok: true, data: updated });
}

/** 부서 삭제 — 비어 있을 때만 */
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireAdminOrg();
  if ('error' in ctx) return ctx.error;

  const managedIds = await getManagedDepartmentIds(ctx.departmentId);
  const target = await loadDepartment(params.id, ctx.organizationId, managedIds);
  if (!target) {
    return NextResponse.json({ ok: false, error: { message: '부서를 찾을 수 없습니다.' } }, { status: 404 });
  }

  if (target.id === ctx.departmentId) {
    return NextResponse.json({ ok: false, error: { message: '본인이 속한 부서는 삭제할 수 없습니다.' } }, { status: 400 });
  }

  // 하위 부서·소속 인원·비서가 남아 있으면 지우지 않는다.
  // departments.parent_id는 ON DELETE SET NULL이라 하위 부서가 조용히 최상위로
  // 올라가고, users.department_id도 끊겨 소속을 잃는다.
  const [{ count: childCount }, { count: userCount }, { count: agentCount }] = await Promise.all([
    supabaseAdmin.from('departments').select('id', { count: 'exact', head: true }).eq('parent_id', target.id),
    supabaseAdmin.from('users').select('id', { count: 'exact', head: true }).eq('department_id', target.id),
    supabaseAdmin.from('agents').select('id', { count: 'exact', head: true }).eq('department_id', target.id),
  ]);

  const blockers: string[] = [];
  if (childCount) blockers.push(`하위 부서 ${childCount}개`);
  if (userCount) blockers.push(`소속 직원 ${userCount}명`);
  if (agentCount) blockers.push(`비서 ${agentCount}개`);

  if (blockers.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        error: { message: `${blockers.join(', ')}이(가) 남아 있어 삭제할 수 없습니다. 먼저 옮기거나 정리해주세요.` },
      },
      { status: 409 }
    );
  }

  const { error } = await supabaseAdmin
    .from('departments')
    .delete()
    .eq('id', target.id)
    .eq('organization_id', ctx.organizationId);

  if (error) {
    console.error('[departments DELETE]', error);
    return NextResponse.json({ ok: false, error: { message: '부서 삭제에 실패했습니다.' } }, { status: 500 });
  }

  return NextResponse.json({ ok: true, data: { id: target.id } });
}
