// src/lib/org-api/keys.ts
// 기관 통계 읽기 API(0075) — 키 만들기·확인·호출 기록(서버). 규칙은 spec.ts.
//
// - 키는 `wo_api_` + 32바이트. **원문은 만든 응답에서 한 번만** 보이고 DB에는 SHA-256만 남는다. 유효 기간 30·90·365일, 회수할 수 있다.
// - 호출마다: 키 차지(`org_api_key_claim` — 유효·하루 1,000번을 행 잠금으로 원자적으로) → 기관 접속 허용 IP(있으면) → 키 범위 →
//   **키를 만든 관리자가 아직 그 기관의 전체 관리자인가**(활성·탈퇴 아님·ADMIN·최상위 부서) → 그 관리자의 관리 범위로 숫자를 센다.
// - 무효 키(없음·회수·만료·꼴이 틀림)는 모두 같은 401 — 어느 키가 있었는지 밖에 가르지 않는다.
// - 차지한 호출은 결과(상태 코드)와 함께 `org_api_key_calls`에 남는다(요청 값·응답 내용은 남기지 않는다).
import { createHash, randomBytes } from 'crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getManagedDepartmentIds } from '@/lib/department-scope';
import { isIpAllowed } from '@/lib/ip-access';
import {
  ORG_API_CREATOR_UNAVAILABLE, ORG_API_DAILY_LIMIT, ORG_API_DAILY_LIMITED, ORG_API_ENDPOINTS, ORG_API_INVALID_TOKEN, ORG_API_IP_DENIED,
  ORG_API_SCOPE_DENIED, ORG_API_SHOWN_PREFIX_CHARS, ORG_API_TOKEN_PREFIX, bearerOrgApiToken, type OrgApiEndpoint, type OrgApiScope,
} from './spec';

export function hashOrgApiToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateOrgApiToken(): { token: string; hash: string; prefix: string } {
  const token = `${ORG_API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashOrgApiToken(token), prefix: token.slice(0, ORG_API_SHOWN_PREFIX_CHARS) };
}

export type OrgApiClaim =
  | { ok: true; key: { id: string; organization_id: string; created_by: string; scopes: string[] } }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'daily_limit'; key_id: string; organization_id: string };

export type OrgApiCreator = { id: string; role: string | null; is_active: boolean | null; deleted_at: string | null; department_id: string | null };

export interface OrgApiDeps {
  claim(tokenHash: string, nowMs: number): Promise<OrgApiClaim>;
  loadCreator(userId: string): Promise<OrgApiCreator | null>;
  loadDepartment(departmentId: string): Promise<{ organization_id: string | null; parent_id: string | null } | null>;
  /** 기관 접속 허용 IP(0023) — 비었거나 NULL이면 제한 없음 */
  allowedIps(organizationId: string): Promise<string[] | null>;
  managedDepartmentIds(departmentId: string): Promise<string[]>;
  recordCall(keyId: string, organizationId: string, endpoint: OrgApiEndpoint, httpStatus: number): Promise<void>;
  now(): number;
}

/** 확인을 통과한 호출 — 숫자를 셀 범위 */
export interface OrgApiContext {
  keyId: string;
  organizationId: string;
  /** 키를 만든 관리자의 관리 범위(기관 전체 관리자라 기관의 모든 부서) */
  departmentIds: string[];
}

export type OrgApiResponse = { status: number; body: Record<string, unknown>; headers?: Record<string, string> };

const fail = (status: number, message: string): OrgApiResponse => ({ status, body: { ok: false, error: { message } } });

/**
 * 호출 하나를 확인하고 `run`으로 숫자를 센다. 차지한 호출은 결과 상태와 함께 기록한다(기록 실패는 응답을 바꾸지 않는다).
 * `run`이 `{ status, message }`를 돌려주면 그 오류로 답한다(입력 오류 400 등)
 */
export async function handleOrgApiCall(
  deps: OrgApiDeps,
  request: { authorization: string | null; ip: string | null },
  endpoint: OrgApiEndpoint,
  run: (ctx: OrgApiContext) => Promise<{ data: unknown } | { status: number; message: string }>,
): Promise<OrgApiResponse> {
  const token = bearerOrgApiToken(request.authorization);
  if (!token) return fail(401, ORG_API_INVALID_TOKEN);
  const claimed = await deps.claim(hashOrgApiToken(token), deps.now());
  if (!claimed.ok) {
    if (claimed.reason === 'daily_limit') {
      await deps.recordCall(claimed.key_id, claimed.organization_id, endpoint, 429).catch(() => {});
      return fail(429, ORG_API_DAILY_LIMITED);
    }
    return fail(401, ORG_API_INVALID_TOKEN);
  }
  const key = claimed.key;
  const respond = async (res: OrgApiResponse) => {
    await deps.recordCall(key.id, key.organization_id, endpoint, res.status).catch(() => {});
    return res;
  };

  const allowed = await deps.allowedIps(key.organization_id);
  // 허용 목록이 있는데 주소를 모르면 막는다 — 화면 세션의 판정(isIpAllowed는 주소를 모르면 통과)과 달리, 밖에서 부르는 API는 닫는 쪽으로
  if (allowed?.length && (!request.ip || !isIpAllowed(request.ip, allowed))) return respond(fail(403, ORG_API_IP_DENIED));
  if (!key.scopes.includes(ORG_API_ENDPOINTS[endpoint].scope as OrgApiScope)) return respond(fail(403, ORG_API_SCOPE_DENIED));

  const creator = await deps.loadCreator(key.created_by);
  const dept = creator?.department_id ? await deps.loadDepartment(creator.department_id) : null;
  const wholeOrgAdmin = Boolean(creator && creator.is_active !== false && !creator.deleted_at && creator.role === 'ADMIN'
    && dept && dept.organization_id === key.organization_id && dept.parent_id == null);
  if (!wholeOrgAdmin) return respond(fail(403, ORG_API_CREATOR_UNAVAILABLE));
  const departmentIds = await deps.managedDepartmentIds(creator!.department_id!);
  if (!departmentIds.length) return respond(fail(403, ORG_API_CREATOR_UNAVAILABLE));

  try {
    const out = await run({ keyId: key.id, organizationId: key.organization_id, departmentIds });
    if ('message' in out) return respond(fail(out.status, out.message));
    return respond({ status: 200, body: { ok: true, data: out.data } });
  } catch (error) {
    console.error('[org-api]', endpoint, error instanceof Error ? error.message : error);
    return respond(fail(500, '통계를 집계하지 못했습니다. 잠시 뒤 다시 호출해 주세요.'));
  }
}

export function orgApiDeps(): OrgApiDeps {
  return {
    async claim(tokenHash, nowMs) {
      const { data, error } = await supabaseAdmin.rpc('org_api_key_claim', { p_token_hash: tokenHash, p_now: new Date(nowMs).toISOString(), p_daily_limit: ORG_API_DAILY_LIMIT });
      if (error) throw new Error(`org_api_key_claim: ${error.message}`);
      return data as OrgApiClaim;
    },
    async loadCreator(userId) {
      const { data, error } = await supabaseAdmin.from('users').select('id, role, is_active, deleted_at, department_id').eq('id', userId).maybeSingle();
      if (error) throw new Error(error.message);
      return (data as OrgApiCreator | null) ?? null;
    },
    async loadDepartment(departmentId) {
      const { data, error } = await supabaseAdmin.from('departments').select('organization_id, parent_id').eq('id', departmentId).maybeSingle();
      if (error) throw new Error(error.message);
      return (data as { organization_id: string | null; parent_id: string | null } | null) ?? null;
    },
    async allowedIps(organizationId) {
      const { data, error } = await supabaseAdmin.from('organizations').select('allowed_ips').eq('id', organizationId).maybeSingle();
      // 읽지 못하면 닫는다 — 제한이 있는 기관의 통계가 밖으로 열리면 안 된다
      if (error) throw new Error(error.message);
      return ((data as { allowed_ips: string[] | null } | null)?.allowed_ips) ?? null;
    },
    managedDepartmentIds: (departmentId) => getManagedDepartmentIds(departmentId),
    async recordCall(keyId, organizationId, endpoint, httpStatus) {
      const { error } = await supabaseAdmin.from('org_api_key_calls').insert({ key_id: keyId, organization_id: organizationId, endpoint, http_status: httpStatus });
      if (error) console.error('[org-api] 호출 기록 실패', error.message);
    },
    now: () => Date.now(),
  };
}
