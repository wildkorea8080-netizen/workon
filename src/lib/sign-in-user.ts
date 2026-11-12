/**
 * 로그인 때 `users` 행으로 세션 정보를 정한다(2026-11-12).
 *
 * 예전 로그인(`nextAuthOptions.ts`)은 Supabase Auth를 통과한 계정에 `users` 행이 없거나 부서가 비어 있으면
 * **전체 시스템에서 가장 오래된 부서**(어느 기관이든)를 배정해 행을 만들었고, 하드코딩한 이메일 둘은 관리자로 만들었다.
 * Supabase의 공개 가입(anon 키로 누구나 부를 수 있다)이 켜져 있어, 바깥 사람이 자기 이메일로 Auth 계정을 만들고 확인한 뒤
 * 로그인하면 **첫 기관의 직원**이 되는 길이었다. `/api/signup`은 2026-08에 같은 문제를 닫았는데 로그인 쪽이 남아 있었다.
 *
 * 이제 소속은 `users` 행(초대·도메인 가입·관리자 등록이 만든다)만 정한다. 행이 없거나, 읽지 못했거나, 부서가 비었으면
 * 로그인을 막는다 — 소속을 추측해서 배정하지 않는다(CLAUDE.md 구조적 위험 0). 역할도 행에서만 읽는다.
 * 아무것도 import하지 않는다(시험이 그대로 부른다).
 */

export interface SignInUserRow {
  id: string;
  email?: string | null;
  role?: string | null;
  full_name?: string | null;
  department_id?: string | null;
}

export type SignInDecision =
  | { ok: true; role: 'ADMIN' | 'USER'; departmentId: string; name: string | null }
  | { ok: false; reason: 'lookup_failed' | 'no_user_row' | 'no_department' };

export function decideSignIn(row: SignInUserRow | null, lookupFailed: boolean): SignInDecision {
  if (lookupFailed) return { ok: false, reason: 'lookup_failed' };
  if (!row) return { ok: false, reason: 'no_user_row' };
  const departmentId = typeof row.department_id === 'string' && row.department_id ? row.department_id : null;
  if (!departmentId) return { ok: false, reason: 'no_department' };
  const role = (row.role ?? 'USER').toString().toUpperCase() === 'ADMIN' ? 'ADMIN' : 'USER';
  return { ok: true, role, departmentId, name: row.full_name || row.email || null };
}
