// src/lib/access-scope-error.ts
// 공개 범위(`getAccessScope`)를 구하다 부서를 못 읽은 것 — 아무것도 import하지 않는다.
//
// 2026-11-20: 예전엔 부서 읽기 실패를 '기관 없음'으로 넘겼다. `visibilityFilter`는 기관을 모르면 부서 제한 자료만 남기므로,
// 직원의 비서 목록·관리자의 문서 목록이 **오류 없이 줄어든(대개 빈) 목록**으로 내려갔다(기관 전체 공개가 기본이라 거의 다 빠진다).
// 부서 행이 정말 없는 것(오류 없음)은 예전처럼 좁힌다 — 이 오류는 '못 읽음'만이다.

export class AccessScopeReadError extends Error {
  readonly code: string | null;
  constructor(code: string | null = null) {
    super('access scope unavailable');
    this.name = 'AccessScopeReadError';
    this.code = code;
  }
}

export function isAccessScopeReadError(error: unknown): error is AccessScopeReadError {
  return error instanceof AccessScopeReadError;
}

/**
 * 부서 계통(상위·하위·기관 부서)을 못 읽은 것(2026-11-20) — `getVisibleDepartmentIds`·`getSharedDepartmentIds`·`getManagedDepartmentIds`가 던진다.
 * 예전엔 '자기 부서만'으로 좁혔다(권한을 넓히지 않는 쪽). 그런데 그 범위로 **거르는** 곳에서는 좁힘이 곧 빠짐이다 —
 * 감사 기록·이용통계·사용자 목록에서 하위 부서가, 금지어 필터에서 상위 부서의 금지어가 오류 없이 빠졌다.
 * 부서가 정말 없거나 계통이 비어 있는 것(오류 없음)은 예전처럼 자기 부서만이다.
 */
export class DepartmentScopeReadError extends Error {
  readonly code: string | null;
  constructor(readonly what: 'ancestors' | 'descendants' | 'department' | 'organization', code: string | null = null) {
    super('department scope unavailable');
    this.name = 'DepartmentScopeReadError';
    this.code = code;
  }
}

export function isDepartmentScopeReadError(error: unknown): error is DepartmentScopeReadError {
  return error instanceof DepartmentScopeReadError;
}

export const ACCESS_SCOPE_UNAVAILABLE_MESSAGE = '공개 범위를 지금 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
