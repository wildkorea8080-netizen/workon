// src/lib/managed-scope-response.ts
// 관리 범위(`getManagedDepartmentIds`)를 라우트에서 받는 한 곳 — 못 읽으면 503 응답을 돌려준다(2026-11-20).
//
// 예전엔 관리 범위를 못 읽으면 '자기 부서만'으로 좁혔다(권한을 넓히지 않는 쪽). 그런데 감사 기록·이용통계·사용자 목록·보안 로그가
// 그 범위로 거르기 때문에, 잠깐의 DB 오류에 **하위 부서가 오류 없이 빠진** 화면·CSV가 나갔다(감사 자료가 줄어든 채 제출될 수 있다).
// 쓰는 법: `const managed = await managedDepartmentIdsOr503(departmentId); if (managed instanceof Response) return managed;`
import { NextResponse } from 'next/server';
import { getManagedDepartmentIds } from '@/lib/department-scope';
import { isDepartmentScopeReadError } from '@/lib/access-scope-error';

export const MANAGED_SCOPE_UNAVAILABLE_MESSAGE = '관리 범위를 지금 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';

export async function managedDepartmentIdsOr503(departmentId: string): Promise<string[] | Response> {
  try {
    return await getManagedDepartmentIds(departmentId);
  } catch (err) {
    if (isDepartmentScopeReadError(err)) {
      return NextResponse.json({ ok: false, error: { message: MANAGED_SCOPE_UNAVAILABLE_MESSAGE } }, { status: 503 });
    }
    throw err;
  }
}
