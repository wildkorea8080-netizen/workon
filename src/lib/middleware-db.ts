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
export async function readSuperAdminStatus(cfg: RestConfig | null, sub: unknown, f: FetchLike): Promise<'active' | 'inactive' | 'error'> {
  if (typeof sub !== 'string' || !UUID.test(sub)) return 'inactive';
  if (!cfg) return 'error';
  try {
    const res = await f(`${cfg.url}/rest/v1/users?id=eq.${sub}&select=is_super_admin,is_active,deleted_at`, { headers: headers(cfg) });
    if (!res.ok) return 'error';
    const rows = (await res.json()) as { is_super_admin?: boolean; is_active?: boolean | null; deleted_at?: string | null }[];
    if (!Array.isArray(rows)) return 'error';
    const row = rows[0];
    return row && row.is_super_admin === true && row.is_active !== false && !row.deleted_at ? 'active' : 'inactive';
  } catch {
    return 'error';
  }
}

export const SUPER_STATUS_TTL_MS = 30_000;
export const SUPER_STATUS_STALE_MS = 10 * 60_000;

type CacheEntry = { active: boolean; at: number };

/**
 * 슈퍼관리자 활성 여부 — 30초 안의 기억은 그대로, 지나면 다시 읽는다. 읽지 못하면 10분 안의 마지막 값을 쓰고, 그것도 없으면 막는다
 * (슈퍼관리자는 모든 기관을 다루니 모를 때는 닫는다 — DB가 잠깐 흔들려도 방금 쓰던 슈퍼관리자는 이어 쓴다).
 */
export async function superAdminActive(
  cache: Map<string, CacheEntry>,
  sub: unknown,
  read: (sub: unknown) => Promise<'active' | 'inactive' | 'error'>,
  now = Date.now(),
): Promise<boolean> {
  const key = typeof sub === 'string' ? sub : '';
  const hit = cache.get(key);
  if (hit && now - hit.at < SUPER_STATUS_TTL_MS) return hit.active;
  const status = await read(sub);
  if (status === 'error') return Boolean(hit && now - hit.at < SUPER_STATUS_STALE_MS && hit.active);
  const active = status === 'active';
  if (key) {
    if (cache.size > 200) cache.clear();
    cache.set(key, { active, at: now });
  }
  return active;
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
