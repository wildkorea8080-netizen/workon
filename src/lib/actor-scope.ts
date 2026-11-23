// src/lib/actor-scope.ts
import { isDepartmentScopeReadError } from '@/lib/access-scope-error';
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
/**
 * 요청자의 소속을 못 읽었을 때(2026-11-19). 예전엔 사용자·부서 읽기 실패도 '소속 없음'(null·기관 null)이라 라우트가
 * '소속 부서가 지정되지 않았습니다'(403)로 답했고, **예약·일괄 실행은 그 403을 '앱을 쓸 수 없음'으로 보아 예약을 바로 멈추고
 * 직원에게 메일을 보냈다.** 이제 던진다 — 정말 소속이 없을 때만 null.
 */
export class ActorScopeReadError extends Error {
  constructor(readonly what: 'user' | 'department', readonly code: string | null) {
    super('요청자의 소속을 지금 확인하지 못했습니다.');
    this.name = 'ActorScopeReadError';
  }
}

export function isActorScopeReadError(err: unknown): err is ActorScopeReadError {
  return err instanceof ActorScopeReadError;
}

export const ACTOR_SCOPE_UNAVAILABLE_MESSAGE = '요청자 정보를 지금 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';

/** 부서 계통(상위·하위)을 못 읽은 것도 요청자 범위를 못 읽은 것이다(2026-11-20 — 예전엔 '자기 부서만'으로 좁혀 상위 부서의 금지어·하위 부서의 감사 기록이 빠졌다) */
function scopeUnread(err: unknown): never {
  if (isDepartmentScopeReadError(err)) throw new ActorScopeReadError('department', err.code);
  throw err;
}

export async function getActorScope(session: Session | null): Promise<ActorScope | null> {
  const userId = session?.user?.id;
  if (!userId) return null;

  let departmentId: string | null = session.user.departmentId ?? null;
  if (!departmentId) {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('department_id')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw new ActorScopeReadError('user', (error as { code?: string }).code ?? null);
    departmentId = data?.department_id ?? null;
  }
  if (!departmentId) return null;

  const isAdmin = isAdminSession(session);
  const [{ data: dept, error: deptError }, visibleDepartmentIds, managedDepartmentIds] = await Promise.all([
    supabaseAdmin
      .from('departments')
      .select('organization_id, parent_id')
      .eq('id', departmentId)
      .maybeSingle(),
    getVisibleDepartmentIds(departmentId).catch(scopeUnread),
    isAdmin ? getManagedDepartmentIds(departmentId).catch(scopeUnread) : Promise.resolve([] as string[]),
  ]);

  // 부서를 못 읽으면 '기관 없음'으로 보지 않는다
  if (deptError) throw new ActorScopeReadError('department', (deptError as { code?: string }).code ?? null);
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
