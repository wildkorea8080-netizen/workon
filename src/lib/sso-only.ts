// src/lib/sso-only.ts
// 기관 SSO 전용(2026-11-25, 0109) — 기관이 '직원은 기관 계정으로만'을 켰으면 직원(USER)의 이메일·비밀번호 로그인을 막는다.
// 로그인(nextAuthOptions.ts의 두 길)이 비밀번호가 맞은 뒤 부른다. 관리자(ADMIN)는 막지 않는다 — 계정 서비스가 고장 나거나
// 설정이 틀려도 설정을 고칠 사람이 들어올 수 있게. 못 읽으면 막지 않는다(열림 — 장기 미접속 잠금과 같다, 운영 기록에 남김).
// 이미 비밀번호로 들어와 있던 직원의 로그인은 미들웨어(middleware-db.ts `deptSsoOnly`)가 끝낸다.
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logSystem } from '@/lib/logger';

export interface SsoOnlyIo {
  /** 부서의 기관 — 없으면 null, 못 읽으면 던진다 */
  orgOfDepartment(departmentId: string): Promise<string | null>;
  /** 기관 SSO 설정의 켜짐·SSO 전용 — 없으면 null, 못 읽으면 던진다 */
  loadSsoFlags(organizationId: string): Promise<{ enabled: boolean; sso_only?: boolean | null } | null>;
  warn(step: string): Promise<void>;
}

export function defaultSsoOnlyIo(): SsoOnlyIo {
  return {
    async orgOfDepartment(departmentId) {
      const { data, error } = await supabaseAdmin.from('departments').select('organization_id').eq('id', departmentId).maybeSingle();
      if (error) throw new Error('departments');
      return (data as { organization_id: string | null } | null)?.organization_id ?? null;
    },
    async loadSsoFlags(organizationId) {
      const { data, error } = await supabaseAdmin.from('org_sso_providers').select('enabled, sso_only').eq('organization_id', organizationId).maybeSingle();
      if (error) throw new Error('org_sso_providers');
      return (data as { enabled: boolean; sso_only?: boolean | null } | null) ?? null;
    },
    async warn(step) {
      await logSystem({ level: 'warning', category: 'auth', message: `SSO 전용 여부를 확인하지 못했습니다(${step}) — 비밀번호 로그인을 막지 않음`, details: {} }).catch(() => {});
    },
  };
}

/** 이 사람의 이메일·비밀번호 로그인을 막아야 하는가 — 직원(USER)이고 그 기관이 켜진 SSO에 'SSO 전용'을 골랐을 때만 참 */
export async function passwordLoginBlocked(user: { role: string | null | undefined; departmentId: string | null | undefined }, io: SsoOnlyIo = defaultSsoOnlyIo()): Promise<boolean> {
  if (String(user.role ?? '').toUpperCase() === 'ADMIN' || !user.departmentId) return false;
  let step = 'department';
  try {
    const org = await io.orgOfDepartment(user.departmentId);
    if (!org) return false;
    step = 'config';
    const flags = await io.loadSsoFlags(org);
    return flags?.enabled === true && flags.sso_only === true;
  } catch {
    await io.warn(step);
    return false;
  }
}
