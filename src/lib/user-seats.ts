import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * 기관의 사용자 수 상한(2026-11-17) — `organizations.max_users`(계약·요금제가 정함, `contract-sync.ts`가 맞춘다).
 *
 * 예전에는 슈퍼관리자 화면이 '사용자 4 / 20명'처럼 보이기만 하고 어디서도 막지 않아, 기관 관리자가 등록·일괄 등록·초대로
 * 상한을 넘겨 얼마든지 계정을 만들 수 있었다(계약서의 인원과 실제가 어긋남). 이제 계정을 새로 만들거나 사용 중지 계정을
 * 다시 켜는 네 길(관리자 등록·일괄 등록·초대 가입 두 곳·다시 사용)이 만들기 **전에** 센다.
 *
 * - 세는 것: 그 기관 부서에 속한 **활성·탈퇴 안 한** 계정(사용 중지 계정은 자리를 차지하지 않는다 — 퇴직자를 끄면 자리가 난다)
 * - 상한이 없거나(NULL·0) 999,999 이상이면 무제한(요금제 표의 '무제한' 표기와 같다)
 * - 상한·수를 못 읽으면 **만들지 않는다**(503) — 열면 상한이 조용히 꺼진다. 계정 만들기는 드문 관리 작업이라 다시 시도하면 된다
 * - 거의 동시에 두 계정을 만들면 하나 넘을 수 있다(행 잠금 없음 — 계약 인원 관리용이지 보안 경계가 아니다)
 * - 슈퍼관리자의 '다시 사용'은 세지 않는다(계약을 정하는 쪽이라 넘겨야 할 때가 있다)
 */

export const SEAT_UNLIMITED = 999_999;

export function seatLimitOf(maxUsers: unknown): number | null {
  const n = typeof maxUsers === 'number' ? maxUsers : Number(maxUsers);
  if (maxUsers === null || maxUsers === undefined || !Number.isFinite(n) || n <= 0 || n >= SEAT_UNLIMITED) return null;
  return Math.floor(n);
}

export const SEAT_LIMIT_CODE = 'SEAT_LIMIT';
export const SEAT_UNKNOWN_CODE = 'SEAT_UNKNOWN';

export function seatLimitMessage(limit: number): string {
  return `기관의 사용자 수 상한(${limit}명)에 닿아 계정을 더 만들 수 없습니다. 사용하지 않는 계정을 사용 중지하거나, 서비스 운영자에게 계약 인원 변경을 요청하세요.`;
}
export const SEAT_UNKNOWN_MESSAGE = '기관의 사용자 수를 확인하지 못해 계정을 만들지 않았습니다. 잠시 뒤 다시 시도해 주세요.';

export type SeatCheck =
  | { ok: true; used: number; limit: number | null; remaining: number | null }
  | { ok: false; status: 403 | 503; code: typeof SEAT_LIMIT_CODE | typeof SEAT_UNKNOWN_CODE; message: string; used?: number; limit?: number };

export interface SeatDeps {
  /** 부서 → 기관 id·상한. 부서가 없으면 null */
  orgOfDepartment(departmentId: string): Promise<{ organizationId: string; maxUsers: unknown } | null>;
  /** 그 기관의 활성·탈퇴 안 한 계정 수 */
  activeUsers(organizationId: string): Promise<number>;
}

export function seatDeps(): SeatDeps {
  return {
    async orgOfDepartment(departmentId) {
      const { data, error } = await supabaseAdmin
        .from('departments')
        .select('organization_id, organizations!inner(max_users)')
        .eq('id', departmentId)
        .maybeSingle();
      if (error) throw error;
      if (!data?.organization_id) return null;
      const org = (data as { organizations?: { max_users?: unknown } | Array<{ max_users?: unknown }> }).organizations;
      const maxUsers = Array.isArray(org) ? org[0]?.max_users : org?.max_users;
      return { organizationId: data.organization_id as string, maxUsers };
    },
    async activeUsers(organizationId) {
      const { count, error } = await supabaseAdmin
        .from('users')
        .select('id, departments!inner(organization_id)', { count: 'exact', head: true })
        .eq('departments.organization_id', organizationId)
        .eq('is_active', true)
        .is('deleted_at', null);
      if (error) throw error;
      if (typeof count !== 'number') throw new Error('count missing');
      return count;
    },
  };
}

/** 이 부서의 기관에 계정 `adding`개를 더 만들어도 되는가. 던지지 않는다 */
export async function checkUserSeats(departmentId: string, adding = 1, deps: SeatDeps = seatDeps()): Promise<SeatCheck> {
  try {
    const org = await deps.orgOfDepartment(departmentId);
    if (!org) return { ok: false, status: 503, code: SEAT_UNKNOWN_CODE, message: SEAT_UNKNOWN_MESSAGE };
    const limit = seatLimitOf(org.maxUsers);
    if (limit === null) return { ok: true, used: 0, limit: null, remaining: null };
    const used = await deps.activeUsers(org.organizationId);
    const remaining = Math.max(0, limit - used);
    if (adding > remaining) return { ok: false, status: 403, code: SEAT_LIMIT_CODE, message: seatLimitMessage(limit), used, limit };
    return { ok: true, used, limit, remaining };
  } catch {
    return { ok: false, status: 503, code: SEAT_UNKNOWN_CODE, message: SEAT_UNKNOWN_MESSAGE };
  }
}

/**
 * 화면에 보일 자리 현황(2026-11-17) — 상한이 없어도 쓴 수는 센다. 못 읽으면 null(표시만 빠진다).
 * 세는 규칙은 `checkUserSeats`와 같다(그 기관의 활성·탈퇴 안 한 계정)
 */
export async function seatUsage(departmentId: string, deps: SeatDeps = seatDeps()): Promise<{ used: number; limit: number | null } | null> {
  try {
    const org = await deps.orgOfDepartment(departmentId);
    if (!org) return null;
    return { used: await deps.activeUsers(org.organizationId), limit: seatLimitOf(org.maxUsers) };
  } catch {
    return null;
  }
}

/** 라우트가 그대로 돌려줄 응답 몸 */
export function seatErrorBody(check: Extract<SeatCheck, { ok: false }>) {
  return { ok: false as const, error: { message: check.message, code: check.code } };
}
