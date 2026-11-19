/**
 * 대리 접근으로 들어갈 기관 관리자 고르기(2026-11-19).
 *
 * 관리 범위는 '자기 부서 + 하위'이고 최상위 부서의 관리자만 기관 전체를 관리한다(`getManagedDepartmentIds`).
 * 예전에는 가장 먼저 만든 관리자 하나를 골라, 그 사람이 하위 부서 관리자면 슈퍼관리자가 그 부서 아래만 보며
 * 기관 전체를 본 줄 알았다. 이제 최상위 부서의 관리자를 먼저 고르고, 없으면 하위 부서 관리자로 들어가되 그렇다고 알린다.
 *
 * 아무것도 import하지 않는다.
 */
export type ImpersonationAdmin = { id: string; department_id: string | null; created_at?: string | null };
export type ImpersonationDept = { id: string; name?: string | null; parent_id: string | null };

export type ImpersonationPick<T extends ImpersonationAdmin> = {
  user: T;
  /** 최상위 부서의 관리자 — 기관 전체를 본다 */
  wholeOrganization: boolean;
  departmentName: string | null;
};

export function pickImpersonationTarget<T extends ImpersonationAdmin>(
  admins: T[],
  depts: ImpersonationDept[],
  superAdminId: string,
): ImpersonationPick<T> | null {
  const byId = new Map(depts.map((d) => [d.id, d]));
  // 이 기관 부서의 관리자만, 슈퍼관리자 본인 계정은 뒤로
  const inOrg = admins.filter((a) => a.department_id && byId.has(a.department_id));
  const ordered = [...inOrg.filter((a) => a.id !== superAdminId), ...inOrg.filter((a) => a.id === superAdminId)];
  const isTop = (a: T) => byId.get(a.department_id as string)?.parent_id == null;
  const user = ordered.find(isTop) ?? ordered[0];
  if (!user) return null;
  const dept = byId.get(user.department_id as string);
  return { user, wholeOrganization: isTop(user), departmentName: dept?.name ?? null };
}

/** 하위 부서 관리자로 들어갈 때 알리는 글 */
export function narrowImpersonationNotice(departmentName: string | null): string {
  const where = departmentName ? `'${departmentName}'` : '하위 부서';
  return `기관 전체 관리자(최상위 부서의 관리자)가 없어 ${where} 관리자로 들어갑니다 — 그 부서와 하위 부서만 보입니다.`;
}
