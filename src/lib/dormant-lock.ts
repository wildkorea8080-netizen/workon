import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * 장기 미접속 계정 잠금(2026-11-16, 0095) — 기관이 켤 때만.
 *
 * 마지막 활동 = 마지막 로그인·가입·관리자가 다시 사용하게 한 때·비밀번호 바꾼 때·기관이 켠 때 중 가장 늦은 때.
 * 그로부터 정한 기간(30~365일)이 지났으면, 비밀번호가 맞은 로그인이라도 계정을 '사용 중지'로 돌리고 막는다.
 * 관리자가 '다시 사용'으로 풀면 그때부터 다시 센다. 확인을 못 하면 막지 않는다(열림 — 잠금은 두 번째 층).
 */

export const DORMANT_MIN_DAYS = 30;
export const DORMANT_MAX_DAYS = 365;
export const DORMANT_CHOICES = [30, 60, 90, 180, 365] as const;

export type DormantFacts = {
  lastSignInAt?: string | null;
  createdAt?: string | null;
  reactivatedAt?: string | null;
  passwordChangedAt?: string | null;
};

export type DormantPolicy = { days: number | null; since: string | null };

/** 순수 판정 — 잠글 때면 true */
export function isDormant(facts: DormantFacts, policy: DormantPolicy, nowMs = Date.now()): boolean {
  if (!policy.days || !policy.since) return false;
  const times = [facts.lastSignInAt, facts.createdAt, facts.reactivatedAt, facts.passwordChangedAt, policy.since]
    .map((t) => (t ? Date.parse(t) : NaN))
    .filter((t) => Number.isFinite(t));
  if (times.length === 0) return false;
  const lastActivity = Math.max(...times);
  return nowMs - lastActivity > policy.days * 86_400_000;
}

export function validDormantDays(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= DORMANT_MIN_DAYS && v <= DORMANT_MAX_DAYS;
}

export interface DormantDeps {
  /** 그 직원의 활동 시각들과 기관 정책 — 못 읽으면 null */
  load(userId: string): Promise<{ facts: DormantFacts; policy: DormantPolicy; departmentId: string | null } | null>;
  /** 계정을 사용 중지로 돌리고 보안 로그를 남긴다 */
  lock(userId: string, departmentId: string | null, days: number): Promise<void>;
}

/** 로그인 직전 확인 — 잠갔으면 true(로그인 막음). 못 읽으면 false */
export async function lockIfDormant(deps: DormantDeps, userId: string, nowMs = Date.now()): Promise<boolean> {
  try {
    const row = await deps.load(userId);
    if (!row || !isDormant(row.facts, row.policy, nowMs)) return false;
    await deps.lock(userId, row.departmentId, row.policy.days ?? 0);
    return true;
  } catch {
    return false;
  }
}

export function dormantDeps(): DormantDeps {
  return {
    async load(userId) {
      const { data, error } = await supabaseAdmin
        .from('users')
        .select('department_id, created_at, last_sign_in_at, reactivated_at, password_changed_at, departments(organizations(dormant_lock_days, dormant_lock_since))')
        .eq('id', userId)
        .maybeSingle();
      if (error || !data) return null;
      const dept = (Array.isArray(data.departments) ? data.departments[0] : data.departments) as { organizations?: unknown } | null;
      const orgRaw = dept?.organizations;
      const org = (Array.isArray(orgRaw) ? orgRaw[0] : orgRaw) as { dormant_lock_days?: number | null; dormant_lock_since?: string | null } | null;
      return {
        departmentId: data.department_id ?? null,
        facts: {
          lastSignInAt: data.last_sign_in_at,
          createdAt: data.created_at,
          reactivatedAt: data.reactivated_at,
          passwordChangedAt: data.password_changed_at,
        },
        policy: { days: org?.dormant_lock_days ?? null, since: org?.dormant_lock_since ?? null },
      };
    },
    async lock(userId, departmentId, days) {
      const { error } = await supabaseAdmin.from('users').update({ is_active: false }).eq('id', userId).is('deleted_at', null);
      if (error) throw new Error(error.message);
      await supabaseAdmin.from('security_logs').insert({
        department_id: departmentId,
        user_id: userId,
        event_type: 'user_dormant_locked',
        details: { days },
        severity: 'medium',
        created_at: new Date().toISOString(),
      }).then(() => undefined, () => undefined);
    },
  };
}
