// src/lib/actor-scope.ts
import type { Session } from 'next-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isAdminSession } from '@/lib/auth';
import { getVisibleDepartmentIds, getManagedDepartmentIds } from '@/lib/department-scope';
import type { ActorScope } from '@/lib/agent-permissions';

/**
 * 세션 → 권한 판정에 쓰는 요청자 범위.
 *
 * 소속을 알 수 없으면 null을 돌려준다. 라우트는 403으로 거절한다 —
 * 소속을 추측해서 배정하지 않는다(CLAUDE.md 구조적 위험 0).
 * 부서 조회가 실패하면 기관을 모르는 상태가 되어 모든 판정이 거절된다.
 */
export async function getActorScope(session: Session | null): Promise<ActorScope | null> {
  const userId = session?.user?.id;
  if (!userId) return null;

  let departmentId: string | null = session.user.departmentId ?? null;
  if (!departmentId) {
    const { data } = await supabaseAdmin
      .from('users')
      .select('department_id')
      .eq('id', userId)
      .maybeSingle();
    departmentId = data?.department_id ?? null;
  }
  if (!departmentId) return null;

  const isAdmin = isAdminSession(session);
  const [{ data: dept }, visibleDepartmentIds, managedDepartmentIds] = await Promise.all([
    supabaseAdmin
      .from('departments')
      .select('organization_id, parent_id')
      .eq('id', departmentId)
      .maybeSingle(),
    getVisibleDepartmentIds(departmentId),
    isAdmin ? getManagedDepartmentIds(departmentId) : Promise.resolve([] as string[]),
  ]);

  const organizationId: string | null = dept?.organization_id ?? null;

  return {
    userId,
    isAdmin,
    departmentId,
    organizationId,
    visibleDepartmentIds,
    managedDepartmentIds,
    // getManagedDepartmentIds와 같은 규칙: 상위가 없는 부서 소속 관리자는 기관 전체
    managesWholeOrganization: isAdmin && Boolean(organizationId) && dept?.parent_id == null,
  };
}
