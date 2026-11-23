import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { AccessScopeReadError, DepartmentScopeReadError, isDepartmentScopeReadError } from '@/lib/access-scope-error';

/**
 * 부서 계층 기반 접근 범위.
 *
 * 공공기관은 기관 > 국/본부 > 과 > 팀처럼 위계가 깊습니다. 상위 부서에 등록한
 * 공통 규정·비서를 하위 부서가 함께 쓸 수 있어야 전 부서 활용이 됩니다.
 *
 * 방향을 혼동하기 쉬우니 분명히 해둡니다:
 *   - 어떤 직원이 볼 수 있는 자료 = 자기 부서 + **상위** 부서들의 자료
 *   - 어떤 부서에 공유하면 누가 보나 = 그 부서 + **하위** 부서들
 */

/** 상위 부서를 몇 단계까지 따라 올라갔는지 로그로 남길 때 쓰는 상한 (순환 방지용 안전장치) */
const MAX_DEPTH = 20;

export interface AccessScope {
  organizationId: string | null;
  /** 자기 부서 + 상위 부서들 */
  visibleDepartmentIds: string[];
}

/**
 * 자료 조회에 필요한 범위 일체.
 *
 * 공개 범위가 둘이라 기관 id와 부서 계통을 함께 알아야 합니다:
 *   visibility='organization' → 같은 기관이면 전부
 *   visibility='department'   → 내 부서 계통에 걸린 것만
 */
export async function getAccessScope(departmentId: string): Promise<AccessScope> {
  if (!departmentId) return { organizationId: null, visibleDepartmentIds: [] };

  const [{ data: dept, error }, visibleDepartmentIds] = await Promise.all([
    supabaseAdmin
      .from('departments')
      .select('organization_id')
      .eq('id', departmentId)
      .maybeSingle(),
    // 상위 부서를 못 읽은 것도 공개 범위를 못 읽은 것이다
    getVisibleDepartmentIds(departmentId).catch((err) => {
      if (isDepartmentScopeReadError(err)) throw new AccessScopeReadError(err.code);
      throw err;
    }),
  ]);
  // 부서를 못 읽으면 던진다(2026-11-20) — '기관 없음'으로 넘기면 기관 전체 공개 자료가 목록에서 오류 없이 빠진다.
  // 부서 행이 정말 없으면(오류 없음) 예전처럼 좁힌다
  if (error) throw new AccessScopeReadError(error.code ?? null);

  return {
    organizationId: dept?.organization_id ?? null,
    visibleDepartmentIds,
  };
}

/**
 * Supabase `.or()` 필터 문자열.
 *
 * 기관 전체 공개이거나, 부서 제한이면서 내 부서 계통에 걸린 것.
 * 기관 id를 모르면 부서 제한만 남겨 범위를 좁힌다 — 알 수 없을 때 넓히면 안 된다.
 */
export function visibilityFilter(scope: AccessScope): string {
  const deptList = scope.visibleDepartmentIds.join(',');

  // 기관 id를 모르면 부서 조건만 남겨 범위를 좁힌다.
  if (!scope.organizationId) {
    return `and(visibility.eq.department,department_id.in.(${deptList}))`;
  }

  const org = scope.organizationId;

  // 부서 조건에도 기관을 함께 건다.
  //
  // organization_id는 트리거가 department_id로부터 채우므로 정상 상태에서는
  // 둘이 어긋날 수 없다. 다만 이 프로젝트에서 트리거가 빠진 채 컬럼만 있던
  // 적이 실제로 있었고(0022), 그런 상태에서 department_id만 보면 기관이
  // 다른 행도 부서 조건에 걸린다. 조건을 하나 더 걸어 두면 트리거가 다시
  // 사라져도 자료가 기관을 넘지 않는다.
  //
  // organization_id가 NULL인 행은 이 조건에서 빠져 아무에게도 안 보인다.
  // 보이는 쪽으로 열어 두는 것보다 안전하다 — 그런 행은
  // `npm run db:check`가 잡아낸다.
  return [
    `and(visibility.eq.organization,organization_id.eq.${org})`,
    `and(visibility.eq.department,organization_id.eq.${org},department_id.in.(${deptList}))`,
  ].join(',');
}

/**
 * 이 부서 직원이 접근 가능한 부서 id 목록 (자기 자신 + 모든 상위 부서).
 *
 * RPC 호출이 실패하면 자기 부서만 돌려줍니다. 계층 조회 실패가 접근 범위를
 * 넓히는 방향으로 작동하면 안 되므로, 실패 시에는 가장 좁은 범위로 떨어집니다.
 */
export async function getVisibleDepartmentIds(departmentId: string): Promise<string[]> {
  if (!departmentId) return [];

  const { data, error } = await supabaseAdmin.rpc('department_ancestors', {
    p_department_id: departmentId,
  });

  // 못 읽으면 던진다(2026-11-20) — '자기 부서만'으로 좁히면 상위 부서의 금지어·부서 제한 자료가 오류 없이 빠진다
  if (error) throw new DepartmentScopeReadError('ancestors', (error as { code?: string }).code ?? null);
  if (!Array.isArray(data) || data.length === 0) return [departmentId];

  const ids = data
    .map((row: { id: string }) => row.id)
    .filter((id: string) => typeof id === 'string')
    .slice(0, MAX_DEPTH);

  // RPC 결과에 자기 자신이 반드시 포함되지만, 방어적으로 한 번 더 확인한다
  return ids.includes(departmentId) ? ids : [departmentId, ...ids];
}

/**
 * 관리자가 관리할 수 있는 부서 범위.
 *
 * 계층 의미를 그대로 따릅니다 — 자기 아래를 관리합니다. 과 단위 관리자는
 * 자기 과 아래만, **기관 직속(최상위) 부서 소속 관리자는 기관 전체를** 관리합니다.
 *
 * 뒤쪽이 중요합니다. 예전에는 하위 부서만 돌려줬는데, 그러면 최상위 부서가
 * 둘 이상인 기관에서 아무도 기관 전체를 관리할 수 없었습니다. 실제로 부서
 * 셋이 모두 최상위인 기관에서 각 관리자가 자기 부서 하나만 보고 있었고,
 * 나머지 부서의 직원·자료는 누구의 관리 범위에도 들어가지 않았습니다.
 * 조직도를 아직 세우지 않은 기관이 흔하므로 도입 초기에 바로 부딪힙니다.
 *
 * 기관 경계는 넘지 않습니다. 최상위 관리자라도 자기 기관 안에서만입니다.
 *
 * `getSharedDepartmentIds`와 이름을 나눠 둔 이유가 여기서 드러납니다 —
 * 자료 공유 영향 범위와 관리 권한 범위는 더 이상 같은 계산이 아닙니다.
 */
export async function getManagedDepartmentIds(departmentId: string): Promise<string[]> {
  if (!departmentId) return [];

  const { data: own, error } = await supabaseAdmin
    .from('departments')
    .select('parent_id, organization_id')
    .eq('id', departmentId)
    .maybeSingle();

  // 못 읽으면 던진다(2026-11-20) — '자기 부서만'으로 좁히면 감사 기록·이용통계·사용자 목록에서 하위 부서가 오류 없이 빠진다.
  // 라우트는 `managedDepartmentIdsOr503`으로 받는다. 부서 행이 정말 없으면 자기 부서만
  if (error) throw new DepartmentScopeReadError('department', (error as { code?: string }).code ?? null);
  if (!own) return [departmentId];

  // 하위 부서를 가진 과 단위 관리자 — 자기 아래만.
  if (own.parent_id) return getSharedDepartmentIds(departmentId);

  // 기관 직속 부서 소속 — 기관 전체.
  if (!own.organization_id) return [departmentId];

  const { data: all, error: allError } = await supabaseAdmin
    .from('departments')
    .select('id')
    .eq('organization_id', own.organization_id);

  if (allError) throw new DepartmentScopeReadError('organization', (allError as { code?: string }).code ?? null);
  if (!Array.isArray(all) || all.length === 0) return getSharedDepartmentIds(departmentId);

  const ids = all.map((row: { id: string }) => row.id);
  return ids.includes(departmentId) ? ids : [departmentId, ...ids];
}

/**
 * 이 부서에 자료를 공유하면 실제로 보게 될 부서 id 목록
 * (자기 자신 + 모든 하위 부서). 관리 화면에서 영향 범위를 보여줄 때 씁니다.
 */
/**
 * 하위 부서 전체(자기 포함) — 못 읽으면 null(2026-11-18).
 * `getSharedDepartmentIds`는 실패하면 자기 부서만 돌려준다(보이는 범위를 좁히는 쪽이라 안전). 그런데 부서 이동의 **순환 검사**가 그 값을 쓰면
 * 실패가 '하위 부서 없음'이 되어 자기 하위 부서 밑으로 옮기는 이동을 통과시킨다(끊어진 고리 — 화면에서 사라지고 재귀 조회가 멈추지 않음).
 * 판정에 쓰는 곳은 이것을 쓰고 null이면 거절한다
 */
export async function departmentDescendantsStrict(
  departmentId: string,
  rpc: (fn: 'department_descendants', args: { p_department_id: string }) => PromiseLike<{ data: unknown; error: unknown }> = (fn, args) => supabaseAdmin.rpc(fn, args),
): Promise<string[] | null> {
  if (!departmentId) return null;
  const { data, error } = await rpc('department_descendants', { p_department_id: departmentId });
  if (error || !Array.isArray(data)) return null;
  const ids = data.map((row: { id?: unknown }) => row?.id).filter((id): id is string => typeof id === 'string');
  return ids.includes(departmentId) ? ids : [departmentId, ...ids];
}

export async function getSharedDepartmentIds(departmentId: string): Promise<string[]> {
  if (!departmentId) return [];

  const { data, error } = await supabaseAdmin.rpc('department_descendants', {
    p_department_id: departmentId,
  });

  if (error) throw new DepartmentScopeReadError('descendants', (error as { code?: string }).code ?? null);
  if (!Array.isArray(data) || data.length === 0) return [departmentId];

  return data.map((row: { id: string }) => row.id).filter((id: string) => typeof id === 'string');
}
