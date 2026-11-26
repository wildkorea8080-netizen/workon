/**
 * 미들웨어(Edge)가 DB에서 읽는 것 — 점검 모드·기관 접속 허용 IP·슈퍼관리자 계정 상태(2026-11-13).
 *
 * 예전 미들웨어는 **공개 키(anon)** 로 PostgREST를 불렀다. 그런데 `system_settings`·`organizations`는 RLS가 켜져 있고
 * 공개 키가 읽을 정책이 없어 **언제나 0행**이 왔다 — 슈퍼관리자 화면의 '점검 모드'를 켜도, 기관 관리자가 '접속 허용 IP'를
 * 정해도 미들웨어에서는 아무 일도 일어나지 않았다(오류 없이 조용히). 이제 **서버 전용 서비스 키**로 읽는다. 미들웨어는 서버에서만
 * 돌아 이 키가 브라우저로 나가지 않는다. 미들웨어는 `config.ts`를 불러오지 않으므로(Edge) 환경 변수를 여기서 한 번만 읽는다.
 *
 * 슈퍼관리자 토큰(24시간)은 서명만 보면 비활성화한 뒤에도 만료까지 쓰인다. 미들웨어가 `/super` 화면·`/api/super` API·점검 모드
 * 통과 때 계정이 아직 활성 슈퍼관리자인지 DB로 다시 본다(30초 기억, 못 읽으면 10분 안의 마지막 값, 그것도 없으면 막음).
 * 아무것도 import하지 않는다(시험이 fetch를 바꿔 끼운다).
 */

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export interface RestConfig {
  url: string;
  key: string;
}

/** 서비스 키로 읽을 설정 — 둘 중 하나라도 없으면 null(읽지 않음) */
export function restConfig(env?: { NEXT_PUBLIC_SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string }): RestConfig | null {
  // Edge 미들웨어는 config.ts를 못 불러와 여기서 직접 읽는다(이름을 그대로 적어야 빌드가 값을 넣는다)
  const url = env ? env.NEXT_PUBLIC_SUPABASE_URL : process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env ? env.SUPABASE_SERVICE_ROLE_KEY : process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ''), key };
}

function headers(cfg: RestConfig): Record<string, string> {
  return { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` };
}

/** 점검 모드 — 못 읽으면 꺼짐(기존 규칙: DB가 흔들려 서비스 전체가 점검 화면으로 가지 않게) */
export async function readMaintenance(cfg: RestConfig | null, f: FetchLike): Promise<{ on: boolean; message: string; ok: boolean }> {
  if (!cfg) return { on: false, message: '', ok: false };
  try {
    const res = await f(`${cfg.url}/rest/v1/system_settings?key=in.(maintenance_mode,maintenance_message)&select=key,value`, { headers: headers(cfg) });
    if (!res.ok) return { on: false, message: '', ok: false };
    const data = (await res.json()) as { key: string; value: string }[];
    if (!Array.isArray(data)) return { on: false, message: '', ok: false };
    const map = Object.fromEntries(data.map((r) => [r.key, r.value]));
    return { on: map.maintenance_mode === 'true', message: typeof map.maintenance_message === 'string' ? map.maintenance_message : '', ok: true };
  } catch {
    return { on: false, message: '', ok: false };
  }
}

/** 접속 허용 IP를 켠 기관의 부서 → 허용 대역. 못 읽으면 빈 표(기존 규칙: IP 제한은 인증 위 두 번째 층이라 열림) */
export async function readIpPolicy(cfg: RestConfig | null, f: FetchLike): Promise<Map<string, string[]>> {
  const byDept = new Map<string, string[]>();
  if (!cfg) return byDept;
  try {
    const orgRes = await f(`${cfg.url}/rest/v1/organizations?select=id,allowed_ips&allowed_ips=not.is.null`, { headers: headers(cfg) });
    if (!orgRes.ok) return byDept;
    const orgs = (await orgRes.json()) as { id: string; allowed_ips: string[] | null }[];
    if (!Array.isArray(orgs)) return byDept;
    const active = orgs.filter((o) => (o.allowed_ips?.length ?? 0) > 0);
    if (active.length === 0) return byDept;
    const ids = active.map((o) => o.id).join(',');
    const deptRes = await f(`${cfg.url}/rest/v1/departments?select=id,organization_id&organization_id=in.(${ids})`, { headers: headers(cfg) });
    if (!deptRes.ok) return byDept;
    const depts = (await deptRes.json()) as { id: string; organization_id: string }[];
    if (!Array.isArray(depts)) return byDept;
    const byOrg = new Map(active.map((o) => [o.id, o.allowed_ips ?? []]));
    for (const d of depts) {
      const list = byOrg.get(d.organization_id);
      if (list) byDept.set(d.id, list);
    }
  } catch {
    return byDept;
  }
  return byDept;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 슈퍼관리자 계정이 지금도 활성인가 — 'active' | 'inactive' | 'error'(못 읽음) */
export interface SuperAdminState { status: 'active' | 'inactive' | 'error'; changedAtMs: number | null; mustChange?: boolean }

/** 슈퍼관리자 계정 상태 + 비밀번호를 바꾼 때(0092, 2026-11-17 — 그 전에 받은 슈퍼관리자 토큰을 끝내려고) */
export async function readSuperAdminState(cfg: RestConfig | null, sub: unknown, f: FetchLike): Promise<SuperAdminState> {
  if (typeof sub !== 'string' || !UUID.test(sub)) return { status: 'inactive', changedAtMs: null };
  if (!cfg) return { status: 'error', changedAtMs: null };
  try {
    const res = await f(`${cfg.url}/rest/v1/users?id=eq.${sub}&select=is_super_admin,is_active,deleted_at,password_changed_at,password_must_change`, { headers: headers(cfg) });
    if (!res.ok) return { status: 'error', changedAtMs: null };
    const rows = (await res.json()) as { is_super_admin?: boolean; is_active?: boolean | null; deleted_at?: string | null; password_changed_at?: string | null; password_must_change?: boolean | null }[];
    if (!Array.isArray(rows)) return { status: 'error', changedAtMs: null };
    const row = rows[0];
    const ok = row && row.is_super_admin === true && row.is_active !== false && !row.deleted_at;
    const changed = row?.password_changed_at ? Date.parse(row.password_changed_at) : NaN;
    return { status: ok ? 'active' : 'inactive', changedAtMs: Number.isFinite(changed) ? changed : null, mustChange: row?.password_must_change === true };
  } catch {
    return { status: 'error', changedAtMs: null };
  }
}

export async function readSuperAdminStatus(cfg: RestConfig | null, sub: unknown, f: FetchLike): Promise<'active' | 'inactive' | 'error'> {
  return (await readSuperAdminState(cfg, sub, f)).status;
}

export const SUPER_STATUS_TTL_MS = 30_000;
export const SUPER_STATUS_STALE_MS = 10 * 60_000;

type CacheEntry = { active: boolean; at: number; changedAtMs?: number | null; mustChange?: boolean };

/**
 * 슈퍼관리자 활성 여부 — 30초 안의 기억은 그대로, 지나면 다시 읽는다. 읽지 못하면 10분 안의 마지막 값을 쓰고, 그것도 없으면 막는다
 * (슈퍼관리자는 모든 기관을 다루니 모를 때는 닫는다 — DB가 잠깐 흔들려도 방금 쓰던 슈퍼관리자는 이어 쓴다).
 */
export async function superAdminActive(
  cache: Map<string, CacheEntry>,
  sub: unknown,
  read: (sub: unknown) => Promise<'active' | 'inactive' | 'error' | SuperAdminState>,
  now = Date.now(),
  /** 토큰을 받은 때(초) — 주면 비밀번호를 바꾼 때보다 앞선 토큰을 끝낸다 */
  iat?: number,
): Promise<boolean> {
  const key = typeof sub === 'string' ? sub : '';
  const fresh = (e: CacheEntry) => e.active && !(typeof iat === 'number' && e.changedAtMs != null && Math.floor(e.changedAtMs / 1000) > iat);
  const hit = cache.get(key);
  // 기억한 값보다 새로 받은 토큰이면 다시 읽는다 — 비밀번호를 바꾸고 다시 로그인한 직후 옛 값(바꾸기 전)을 쓰지 않게
  const newerToken = typeof iat === 'number' && hit && hit.at < iat * 1000;
  if (hit && !newerToken && now - hit.at < SUPER_STATUS_TTL_MS) return fresh(hit);
  const got = await read(sub);
  const state: SuperAdminState = typeof got === 'string' ? { status: got, changedAtMs: null } : got;
  if (state.status === 'error') return Boolean(hit && now - hit.at < SUPER_STATUS_STALE_MS && fresh(hit));
  const entry: CacheEntry = { active: state.status === 'active', at: now, changedAtMs: state.changedAtMs, mustChange: state.mustChange === true };
  if (key) {
    if (cache.size > 200) cache.clear();
    cache.set(key, entry);
  }
  return fresh(entry);
}

/**
 * 임시 비밀번호로 만든 슈퍼관리자인가(0093, 2026-11-17) — `superAdminActive`가 방금 읽어 기억한 값으로 본다(DB를 다시 부르지 않음).
 * 참이면 미들웨어가 비밀번호 바꾸기 화면·API만 열어 둔다
 */
export function superMustChange(cache: Map<string, CacheEntry>, sub: unknown): boolean {
  return typeof sub === 'string' && cache.get(sub)?.mustChange === true;
}

/** 임시 비밀번호인 슈퍼관리자에게 열어 두는 경로 */
export function superAllowedWhileMustChange(pathname: string): boolean {
  return /^\/(super\/password|super\/login|api\/super\/accounts\/me\/password|api\/super\/auth)(\/|$)/.test(pathname);
}

/** 서명을 이미 확인한 토큰에서 받은 때(초) */
export function superTokenIat(token: string): number | undefined {
  try {
    const payload = token.split('.')[1];
    if (!payload) return undefined;
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))) as { iat?: unknown };
    return typeof decoded.iat === 'number' && Number.isFinite(decoded.iat) ? decoded.iat : undefined;
  } catch {
    return undefined;
  }
}

/** 서명을 이미 확인한 토큰에서 sub만 꺼낸다 */
export function superTokenSub(token: string): string | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))) as { sub?: unknown };
    return typeof decoded.sub === 'string' ? decoded.sub : null;
  } catch {
    return null;
  }
}

/**
 * 직원 세션 계정 상태(2026-11-16) — NextAuth 토큰(JWT, 30일)은 서명만 보면 비활성화·탈퇴·권한/소속 변경 뒤에도 만료까지 쓰였다
 * (예전엔 "이미 발급된 세션은 만료까지 남는다"). 미들웨어가 토큰이 있는 요청마다 계정을 DB로 다시 본다(30초 기억).
 * - 'active': 행이 있고 활성·탈퇴 안 함 — 지금 역할·부서를 함께 돌려줘 토큰과 맞대 본다
 * - 'inactive': 행이 없거나 비활성·탈퇴
 * - 'error': 못 읽음
 */
export type UserStatus =
  | { kind: 'active'; role: string | null; departmentId: string | null; passwordChangedAt?: number | null; mustChangePassword?: boolean; /** (0114) 계정 서비스가 알린 기관 계정 로그아웃 시각(ms) */ ssoLogoutAt?: number | null;
      /** (0121) sid로 끝낸 세션 — `{로그아웃 초}:{sid}` */ ssoEndedSessions?: string[]; /** (0121) sid로 받은 로그아웃의 가장 늦은 때(ms) — sid 없는 로그인용 */ ssoSidLogoutAt?: number | null }
  | { kind: 'inactive' }
  | { kind: 'error' };

export async function readUserStatus(cfg: RestConfig | null, sub: unknown, f: FetchLike): Promise<UserStatus> {
  if (typeof sub !== 'string' || !UUID.test(sub)) return { kind: 'inactive' };
  if (!cfg) return { kind: 'error' };
  try {
    const res = await f(`${cfg.url}/rest/v1/users?id=eq.${sub}&select=role,department_id,is_active,deleted_at,password_changed_at,password_must_change,sso_logout_at,sso_ended_sessions,sso_sid_logout_at`, { headers: headers(cfg) });
    if (!res.ok) return { kind: 'error' };
    const rows = (await res.json()) as { role?: string | null; department_id?: string | null; is_active?: boolean | null; deleted_at?: string | null; password_changed_at?: string | null; password_must_change?: boolean | null; sso_logout_at?: string | null; sso_ended_sessions?: unknown; sso_sid_logout_at?: string | null }[];
    if (!Array.isArray(rows)) return { kind: 'error' };
    const row = rows[0];
    if (!row || row.is_active === false || row.deleted_at) return { kind: 'inactive' };
    // 로그인이 토큰에 싣는 역할과 같은 규칙(sign-in-user.ts — 대소문자·빈 값은 USER)
    return { kind: 'active', role: String(row.role ?? 'USER').toUpperCase() === 'ADMIN' ? 'ADMIN' : 'USER', departmentId: typeof row.department_id === 'string' ? row.department_id : null,
      passwordChangedAt: row.password_changed_at ? Date.parse(row.password_changed_at) || null : null,
      mustChangePassword: row.password_must_change === true,
      ssoLogoutAt: row.sso_logout_at ? Date.parse(row.sso_logout_at) || null : null,
      ssoEndedSessions: Array.isArray(row.sso_ended_sessions) ? row.sso_ended_sessions.filter((e): e is string => typeof e === 'string').slice(-20) : [],
      ssoSidLogoutAt: row.sso_sid_logout_at ? Date.parse(row.sso_sid_logout_at) || null : null };
  } catch {
    return { kind: 'error' };
  }
}

export type SessionVerdict = 'ok' | 'inactive' | 'changed' | 'password_changed' | 'must_change_password' | 'sso_only' | 'sso_logged_out';

/**
 * 부서의 기관이 'SSO 전용'(0109 — 켜진 SSO + sso_only)인가. 못 읽으면 'error'(칸이 없던 옛 DB도 — select가 거절됨)
 */
export async function readDeptSsoOnly(cfg: RestConfig | null, departmentId: string, f: FetchLike): Promise<boolean | 'error'> {
  if (!UUID.test(departmentId)) return false;
  if (!cfg) return 'error';
  try {
    const dept = await f(`${cfg.url}/rest/v1/departments?id=eq.${departmentId}&select=organization_id`, { headers: headers(cfg) });
    if (!dept.ok) return 'error';
    const deptRows = (await dept.json()) as { organization_id?: string | null }[];
    if (!Array.isArray(deptRows)) return 'error';
    const org = deptRows[0]?.organization_id;
    if (typeof org !== 'string' || !UUID.test(org)) return false;
    const res = await f(`${cfg.url}/rest/v1/org_sso_providers?organization_id=eq.${org}&select=enabled,sso_only`, { headers: headers(cfg) });
    if (!res.ok) return 'error';
    const rows = (await res.json()) as { enabled?: boolean | null; sso_only?: boolean | null }[];
    if (!Array.isArray(rows)) return 'error';
    return rows[0]?.enabled === true && rows[0]?.sso_only === true;
  } catch {
    return 'error';
  }
}

/** 부서마다 30초 기억, 못 읽으면 10분 안의 마지막 값, 그것도 없으면 **끄지 않음**(열림 — 로그인 쪽 검사와 같다) */
export async function deptSsoOnly(
  cache: Map<string, { on: boolean; at: number }>,
  departmentId: string,
  read: (departmentId: string) => Promise<boolean | 'error'>,
  now = Date.now(),
): Promise<boolean> {
  const hit = cache.get(departmentId);
  if (hit && now - hit.at < SUPER_STATUS_TTL_MS) return hit.on;
  const got = await read(departmentId);
  if (got === 'error') return hit && now - hit.at < SUPER_STATUS_STALE_MS ? hit.on : false;
  if (cache.size > 2000) cache.clear();
  cache.set(departmentId, { on: got, at: now });
  return got;
}
type UserCacheEntry = { status: Exclude<UserStatus, { kind: 'error' }>; at: number };

/**
 * (0121) 이 sid의 로그인이 back-channel 로그아웃으로 끝났나 — 끝낸 세션 항목(`{로그아웃 초}:{sid}`) 중 sid가 같고 로그인이 그때나 그 전인 것.
 * 같은 sid가 나중에 다시 쓰여도(계정 서비스가 번호를 되쓰는 경우) 로그아웃 뒤에 들어온 로그인은 끝내지 않는다
 */
export function sessionEndedBySid(entries: readonly string[] | undefined, sid: string, loginSec: number | null): boolean {
  if (!entries?.length || !sid) return false;
  for (const entry of entries) {
    const colon = entry.indexOf(':');
    if (colon < 1 || entry.slice(colon + 1) !== sid) continue;
    const at = Number(entry.slice(0, colon));
    if (!Number.isInteger(at)) continue;
    if (loginSec === null || loginSec <= at) return true;
  }
  return false;
}

/**
 * 이 토큰을 지금도 받아도 되는가.
 * - 비활성·탈퇴 → 'inactive', 역할·부서가 토큰과 다름 → 'changed'(다시 로그인해야 새 권한·소속이 토큰에 실린다 — 강등된 관리자가
 *   옛 토큰으로 관리자 화면을 쓰거나, 다른 부서로 옮긴 직원이 옛 부서 범위로 보지 않게)
 * - 못 읽으면 10분 안의 마지막 값, 그것도 없으면 **받는다**(직원 전체가 DB 흔들림에 쫓겨나지 않게 — 라우트의 권한 검사는 그대로다).
 *   슈퍼관리자(닫힘)와 다른 까닭이다.
 */
export async function userSessionVerdict(
  cache: Map<string, UserCacheEntry>,
  token: { sub?: unknown; role?: unknown; departmentId?: unknown; authAt?: unknown; iat?: unknown; isImpersonating?: unknown; sso?: unknown; ssoSid?: unknown },
  read: (sub: unknown) => Promise<UserStatus>,
  now = Date.now(),
  /** 기관 SSO 전용(0109)인가 — 부서 id로. 없으면 보지 않는다 */
  ssoOnly?: (departmentId: string) => Promise<boolean>,
): Promise<SessionVerdict> {
  const key = typeof token.sub === 'string' ? token.sub : '';
  const hit = cache.get(key);
  let status: Exclude<UserStatus, { kind: 'error' }> | null = hit && now - hit.at < SUPER_STATUS_TTL_MS ? hit.status : null;
  if (!status) {
    const read1 = await read(token.sub);
    if (read1.kind === 'error') {
      status = hit && now - hit.at < SUPER_STATUS_STALE_MS ? hit.status : null;
      if (!status) return 'ok';
    } else {
      status = read1;
      if (key) {
        if (cache.size > 2000) cache.clear();
        cache.set(key, { status, at: now });
      }
    }
  }
  if (status.kind === 'inactive') return 'inactive';
  const tokenRole = typeof token.role === 'string' ? token.role : null;
  const tokenDept = typeof token.departmentId === 'string' ? token.departmentId : null;
  if (status.role !== tokenRole || status.departmentId !== tokenDept) return 'changed';
  // 비밀번호를 바꾼 뒤(본인·관리자 재발급, 0092) 그 전에 로그인한 토큰은 끝낸다. 로그인한 때는 authAt(ms), 없는 옛 토큰은 iat(초).
  // 같은 초 안에 다시 로그인한 토큰을 잘못 끝내지 않게 초 단위로 맞댄다
  if (status.passwordChangedAt) {
    const loginSec = typeof token.authAt === 'number' ? Math.floor(token.authAt / 1000) : typeof token.iat === 'number' ? token.iat : null;
    if (loginSec !== null && loginSec < Math.floor(status.passwordChangedAt / 1000)) return 'password_changed';
  }
  // 계정 서비스가 먼저 로그아웃했다(back-channel, 0114) — 그때나 그 전에 기관 계정으로 들어온 로그인만 끝낸다(비밀번호 로그인·대리 접근은 그대로)
  if (token.sso === true && token.isImpersonating !== true) {
    const loginSec = typeof token.authAt === 'number' ? Math.floor(token.authAt / 1000) : typeof token.iat === 'number' ? token.iat : null;
    if (status.ssoLogoutAt && loginSec !== null && loginSec <= Math.floor(status.ssoLogoutAt / 1000)) return 'sso_logged_out';
    // sid가 온 로그아웃(0121)은 그 세션 하나만 — 로그인에 sid가 실렸으면 그 sid로 끝낸 항목만 본다. sid를 싣지 않은 로그인
    // (이 배포 전 로그인·id_token에 sid가 없던 로그인)은 어느 세션인지 몰라 예전처럼 sid 로그아웃 시각으로 끝낸다
    if (typeof token.ssoSid === 'string' && token.ssoSid) {
      if (sessionEndedBySid(status.ssoEndedSessions, token.ssoSid, loginSec)) return 'sso_logged_out';
    } else if (status.ssoSidLogoutAt && loginSec !== null && loginSec <= Math.floor(status.ssoSidLogoutAt / 1000)) return 'sso_logged_out';
  }
  // 임시 비밀번호(0093) — 본인이 바꾸기 전까지는 '비밀번호 바꾸기'만. 대리 접근(슈퍼관리자)은 그 관리자 대신 바꾸지 않으므로 묶지 않는다
  // 기관 SSO(0107)로 들어온 로그인도 묶지 않는다 — 비밀번호를 쓰지 않아 지금 비밀번호를 모른다(임시 비밀번호 로그인은 그대로 묶임)
  if (status.mustChangePassword && token.isImpersonating !== true && token.sso !== true) return 'must_change_password';
  // 기관 SSO 전용(0109) — 비밀번호로 들어와 있던 직원 로그인을 끝낸다(SSO 로그인·관리자·대리 접근은 그대로)
  if (ssoOnly && status.role === 'USER' && token.sso !== true && token.isImpersonating !== true && status.departmentId && (await ssoOnly(status.departmentId))) return 'sso_only';
  return 'ok';
}

/**
 * 임시 비밀번호인 동안 열어 두는 길 — 비밀번호 바꾸기 화면·API, 로그인 화면들, 점검·차단 안내, 공개 브랜딩.
 * (/api/auth·정적 파일은 미들웨어가 먼저 내보낸다)
 */
export function allowedWhileMustChange(pathname: string): boolean {
  return /^\/(my\/password|api\/my\/password|login|signin|signup|register|forgot-password|reset-password|api\/password-reset|maintenance|blocked|api\/branding|api\/system\/maintenance)(\/|$)/.test(pathname);
}

/** 지울 NextAuth 세션 쿠키 이름 — 보안 접두어 둘·나눠 담긴 조각(.0 .1 …)까지 */
export function sessionCookieNames(names: string[]): string[] {
  return names.filter((n) => /^(__Secure-)?next-auth\.session-token(\.\d+)?$/.test(n));
}
