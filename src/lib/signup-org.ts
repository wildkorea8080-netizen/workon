import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isStoppedOrgStatus } from '@/lib/org-status';

/**
 * 가입할 부서의 기관 상태(2026-11-19).
 *
 * 예전 초대 가입(`/api/signup`·`/api/register`)과 도메인 가입은 기관 상태를 보지 않아, **정지·종료한 기관에도 새 계정이
 * 만들어졌다**(들어와서는 대화·문서 올리기가 막힌다 — 인원 자리만 차지). 초대·부서를 못 읽으면 '유효하지 않은 초대 링크'로
 * 답해 정상 초대를 받은 사람이 링크가 틀린 줄 알았다. 이제 읽기 실패는 503, 멈춘 기관은 403.
 */
export const STOPPED_ORG_SIGNUP_MESSAGE = '이용이 정지되었거나 종료된 기관이라 가입할 수 없습니다. 기관 관리자에게 문의하세요.';
export const SIGNUP_READ_FAILED_MESSAGE = '가입 정보를 지금 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
export const DEPARTMENT_GONE_MESSAGE = '초대의 소속 부서가 없어졌습니다. 새 초대 링크를 요청하세요.';

export type DepartmentOrgState =
  | { kind: 'ok'; orgName: string | null }
  | { kind: 'stopped'; orgName: string | null }
  | { kind: 'missing' }
  | { kind: 'error' };

export async function departmentOrgState(departmentId: string): Promise<DepartmentOrgState> {
  const { data, error } = await supabaseAdmin
    .from('departments')
    .select('id, organizations(name, status)')
    .eq('id', departmentId)
    .maybeSingle();
  if (error) return { kind: 'error' };
  if (!data) return { kind: 'missing' };
  const raw = (data as { organizations?: unknown }).organizations;
  const org = (Array.isArray(raw) ? raw[0] : raw) as { name?: string | null; status?: string | null } | null | undefined;
  if (!org) return { kind: 'error' }; // 부서에 기관이 없으면(0014 뒤엔 없어야 함) 판정하지 않는다
  const orgName = org.name ?? null;
  return isStoppedOrgStatus(org.status) ? { kind: 'stopped', orgName } : { kind: 'ok', orgName };
}

/** 상태를 응답(오류면) 꼴로 — ok면 null */
export function departmentOrgRejection(state: DepartmentOrgState): { status: number; message: string } | null {
  switch (state.kind) {
    case 'ok': return null;
    case 'stopped': return { status: 403, message: STOPPED_ORG_SIGNUP_MESSAGE };
    case 'missing': return { status: 400, message: DEPARTMENT_GONE_MESSAGE };
    default: return { status: 503, message: SIGNUP_READ_FAILED_MESSAGE };
  }
}
