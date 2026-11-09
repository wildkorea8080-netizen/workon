// src/lib/org-api/admin.ts
// 기관 통계 API 키(0075) 관리 — 기관 전체 관리자만 보고·만들고·회수한다(서버). 규칙은 spec.ts.
// 만들기·회수는 보안 로그(high)에 키 이름·앞부분·범위만 남긴다(원문·해시는 남기지 않는다).
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { ActorScope } from '@/lib/agent-permissions';
import { logSecurityEvent } from '@/lib/filter';
import { generateOrgApiToken } from './keys';
import {
  ORG_API_MAX_ACTIVE_KEYS, ORG_API_WHOLE_ORG_ONLY, keyView, parseCreateKey,
  type OrgApiCallView, type OrgApiEndpoint, type OrgApiKeyView,
} from './spec';

type Fail = { ok: false; status: number; message: string };

/** 기관 전체 관리자인가 — 최상위 부서 소속 관리자(getActorScope의 managesWholeOrganization) */
export function wholeOrgAdminProblem(actor: ActorScope | null): Fail | null {
  if (!actor?.organizationId) return { ok: false, status: 403, message: '소속 기관을 확인할 수 없습니다.' };
  if (!actor.isAdmin || !actor.managesWholeOrganization) return { ok: false, status: 403, message: ORG_API_WHOLE_ORG_ONLY };
  return null;
}

const KEY_COLUMNS = 'id, name, token_prefix, scopes, status, expires_at, revoked_at, last_used_at, use_count, created_at, created_by';
/** 화면에 보이는 최근 호출 수 */
export const RECENT_CALLS = 50;

export async function listOrgApiKeys(actor: ActorScope, nowMs = Date.now()): Promise<{ ok: true; keys: OrgApiKeyView[]; calls: OrgApiCallView[] } | Fail> {
  const problem = wholeOrgAdminProblem(actor);
  if (problem) return problem;
  const [{ data: keys, error }, { data: calls, error: callError }] = await Promise.all([
    supabaseAdmin.from('org_api_keys').select(KEY_COLUMNS).eq('organization_id', actor.organizationId!).order('created_at', { ascending: false }).limit(100),
    supabaseAdmin.from('org_api_key_calls').select('key_id, endpoint, http_status, created_at').eq('organization_id', actor.organizationId!).order('created_at', { ascending: false }).limit(RECENT_CALLS),
  ]);
  if (error || callError) return { ok: false, status: 503, message: 'API 키 목록을 불러오지 못했습니다.' };
  const rows = (keys ?? []) as Array<Parameters<typeof keyView>[0] & { created_by: string }>;
  const creatorIds = [...new Set(rows.map((r) => r.created_by))];
  const names = new Map<string, string>();
  if (creatorIds.length) {
    const { data: users } = await supabaseAdmin.from('users').select('id, full_name').in('id', creatorIds);
    for (const u of (users ?? []) as Array<{ id: string; full_name: string | null }>) names.set(u.id, u.full_name ?? '(이름 없음)');
  }
  const views = rows.map((r) => keyView(r, nowMs, names.get(r.created_by) ?? null));
  const keyName = new Map(views.map((k) => [k.id, k.name]));
  return {
    ok: true,
    keys: views,
    calls: ((calls ?? []) as Array<{ key_id: string; endpoint: OrgApiEndpoint; http_status: number; created_at: string }>).map((c) => ({
      keyId: c.key_id, keyName: keyName.get(c.key_id) ?? '(지운 키)', endpoint: c.endpoint, httpStatus: c.http_status, createdAt: c.created_at,
    })),
  };
}

export async function createOrgApiKey(actor: ActorScope, raw: unknown, nowMs = Date.now()): Promise<{ ok: true; key: OrgApiKeyView; token: string } | Fail> {
  const problem = wholeOrgAdminProblem(actor);
  if (problem) return problem;
  const parsed = parseCreateKey(raw);
  if (!parsed.ok) return { ok: false, status: 400, message: parsed.message };
  const now = new Date(nowMs).toISOString();
  const { count, error: countError } = await supabaseAdmin.from('org_api_keys').select('id', { count: 'exact', head: true })
    .eq('organization_id', actor.organizationId!).eq('status', 'active').gt('expires_at', now);
  if (countError) return { ok: false, status: 503, message: 'API 키를 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  if ((count ?? 0) >= ORG_API_MAX_ACTIVE_KEYS) {
    return { ok: false, status: 409, message: `쓸 수 있는 API 키는 기관에 ${ORG_API_MAX_ACTIVE_KEYS}개까지입니다. 쓰지 않는 키를 먼저 회수해 주세요.` };
  }
  const { token, hash, prefix } = generateOrgApiToken();
  const expiresAt = new Date(nowMs + parsed.value.days * 86_400_000).toISOString();
  const { data, error } = await supabaseAdmin.from('org_api_keys').insert({
    organization_id: actor.organizationId, created_by: actor.userId, name: parsed.value.name, token_hash: hash, token_prefix: prefix,
    scopes: parsed.value.scopes, expires_at: expiresAt, created_at: now, updated_at: now,
  }).select(KEY_COLUMNS).single();
  if (error || !data) return { ok: false, status: 503, message: 'API 키를 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  await logSecurityEvent(actor.departmentId, actor.userId, 'org_api_key_created',
    { key_id: data.id, name: parsed.value.name, token_prefix: prefix, scopes: parsed.value.scopes, expires_at: expiresAt }, 'high');
  return { ok: true, key: keyView(data as Parameters<typeof keyView>[0], nowMs), token };
}

export async function revokeOrgApiKey(actor: ActorScope, keyId: string, nowMs = Date.now()): Promise<{ ok: true } | Fail> {
  const problem = wholeOrgAdminProblem(actor);
  if (problem) return problem;
  if (!/^[0-9a-f-]{36}$/i.test(keyId)) return { ok: false, status: 404, message: 'API 키를 찾을 수 없습니다.' };
  const now = new Date(nowMs).toISOString();
  const { data, error } = await supabaseAdmin.from('org_api_keys')
    .update({ status: 'revoked', revoked_at: now, revoked_by: actor.userId, updated_at: now })
    .eq('id', keyId).eq('organization_id', actor.organizationId!).eq('status', 'active')
    .select('id, name, token_prefix, scopes');
  if (error) return { ok: false, status: 503, message: 'API 키를 회수하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  const row = (data ?? [])[0] as { id: string; name: string; token_prefix: string; scopes: string[] } | undefined;
  if (!row) return { ok: false, status: 404, message: 'API 키를 찾을 수 없거나 이미 회수됐습니다.' };
  await logSecurityEvent(actor.departmentId, actor.userId, 'org_api_key_revoked', { key_id: row.id, name: row.name, token_prefix: row.token_prefix, scopes: row.scopes }, 'high');
  return { ok: true };
}
