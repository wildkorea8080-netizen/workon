import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { writeAuditRow } from '@/lib/audit-write';

/**
 * 직원 접속 기록(2026-11-16, 0094). 직원 로그인은 성공·실패 모두 어디에도 남지 않았다 — 슈퍼관리자 로그인만 `access_logs`에 남았다.
 * 성공·실패·잠김·거절을 `access_logs`에 남기고, 성공이면 `users.last_sign_in_at`도 적는다. 기관 관리자 감사 화면 '접속 기록'이 읽는다.
 *
 * - 비밀번호는 물론 **입력한 이메일도 남기지 않는다** — 계정이 있으면 그 사람(user_id·부서·기관)으로, 없으면 사람 없이 시각·IP만
 *   (없는 계정 이메일은 남의 개인정보이거나 오타다).
 * - 기록 실패는 로그인을 막지 않는다(던지지 않음).
 */

export type SignInOutcome = 'login' | 'login_failed' | 'login_locked' | 'login_rejected';

const STATUS: Record<SignInOutcome, number> = { login: 200, login_failed: 401, login_locked: 429, login_rejected: 403 };

export interface SignInRecordDeps {
  /** 이메일로 계정 찾기 — 사람·부서·기관. 없거나 못 읽으면 null */
  findUser(email: string): Promise<{ id: string; departmentId: string | null; orgId: string | null } | null>;
  /** 부서의 기관 */
  orgOf(departmentId: string): Promise<string | null>;
  insert(row: Record<string, unknown>): Promise<void>;
  touchLastSignIn(userId: string, at: string): Promise<void>;
}

export async function recordSignIn(
  deps: SignInRecordDeps,
  input: {
    outcome: SignInOutcome;
    email: unknown;
    ip: string | null;
    userAgent?: string | null;
    /** 성공한 로그인처럼 사람이 이미 정해졌으면 */
    user?: { id: string; departmentId: string | null } | null;
    now?: Date;
  },
): Promise<void> {
  try {
    const at = (input.now ?? new Date()).toISOString();
    let who: { id: string; departmentId: string | null; orgId: string | null } | null = null;
    if (input.user) {
      who = { ...input.user, orgId: input.user.departmentId ? await deps.orgOf(input.user.departmentId).catch(() => null) : null };
    } else if (typeof input.email === 'string' && input.email.trim()) {
      who = await deps.findUser(input.email.trim().toLowerCase()).catch(() => null);
    }
    await deps.insert({
      user_id: who?.id ?? null,
      department_id: who?.departmentId ?? null,
      org_id: who?.orgId ?? null,
      action: input.outcome,
      path: '/login',
      ip_address: input.ip,
      user_agent: typeof input.userAgent === 'string' ? input.userAgent.slice(0, 300) : null,
      status_code: STATUS[input.outcome],
      details: {},
      created_at: at,
    });
    if (input.outcome === 'login' && who) await deps.touchLastSignIn(who.id, at);
  } catch {
    /* 기록 실패는 로그인을 막지 않는다 */
  }
}

export function signInRecordDeps(): SignInRecordDeps {
  return {
    async findUser(email) {
      const { data, error } = await supabaseAdmin
        .from('users')
        .select('id, department_id, departments(organization_id)')
        .eq('email', email)
        .maybeSingle();
      if (error || !data) return null;
      const dept = Array.isArray(data.departments) ? data.departments[0] : data.departments;
      return { id: data.id, departmentId: data.department_id ?? null, orgId: (dept as { organization_id?: string } | null)?.organization_id ?? null };
    },
    async orgOf(departmentId) {
      const { data } = await supabaseAdmin.from('departments').select('organization_id').eq('id', departmentId).maybeSingle();
      return data?.organization_id ?? null;
    },
    async insert(row) {
      // 실패는 운영 기록에(writeAuditRow — 2026-11-17). 예전에는 던져서 recordSignIn이 조용히 삼켰다
      await writeAuditRow('access_logs', row, String(row.action));
    },
    async touchLastSignIn(userId, at) {
      await supabaseAdmin.from('users').update({ last_sign_in_at: at }).eq('id', userId);
    },
  };
}
