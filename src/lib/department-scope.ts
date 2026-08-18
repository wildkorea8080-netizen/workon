import { supabaseAdmin } from '@/lib/supabaseAdmin';

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

  if (error || !Array.isArray(data) || data.length === 0) {
    if (error) {
      console.warn('[department-scope] department_ancestors 실패, 자기 부서만 사용:', error.message);
    }
    return [departmentId];
  }

  const ids = data
    .map((row: { id: string }) => row.id)
    .filter((id: string) => typeof id === 'string')
    .slice(0, MAX_DEPTH);

  // RPC 결과에 자기 자신이 반드시 포함되지만, 방어적으로 한 번 더 확인한다
  return ids.includes(departmentId) ? ids : [departmentId, ...ids];
}

/**
 * 관리자가 관리할 수 있는 부서 범위 (자기 부서 + 모든 하위 부서).
 *
 * 계층 의미를 그대로 따릅니다 — 자기 아래를 관리합니다. 최상위 부서 소속
 * 관리자는 기관 전체를, 과 단위 관리자는 자기 과 아래만 관리합니다.
 *
 * `getSharedDepartmentIds`와 계산은 같지만 의도가 달라 이름을 나눠 둡니다.
 * (공유 영향 범위 vs 관리 권한 범위)
 */
export async function getManagedDepartmentIds(departmentId: string): Promise<string[]> {
  return getSharedDepartmentIds(departmentId);
}

/**
 * 이 부서에 자료를 공유하면 실제로 보게 될 부서 id 목록
 * (자기 자신 + 모든 하위 부서). 관리 화면에서 영향 범위를 보여줄 때 씁니다.
 */
export async function getSharedDepartmentIds(departmentId: string): Promise<string[]> {
  if (!departmentId) return [];

  const { data, error } = await supabaseAdmin.rpc('department_descendants', {
    p_department_id: departmentId,
  });

  if (error || !Array.isArray(data) || data.length === 0) {
    if (error) {
      console.warn('[department-scope] department_descendants 실패:', error.message);
    }
    return [departmentId];
  }

  return data.map((row: { id: string }) => row.id).filter((id: string) => typeof id === 'string');
}
