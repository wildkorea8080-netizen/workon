import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logSystem } from '@/lib/logger';

/**
 * 감사 기록 한 줄 쓰기 — 실패를 보이게(2026-11-17).
 *
 * Supabase 클라이언트는 실패를 던지지 않고 `{ error }`로 돌려준다. 감사 기록(슈퍼관리자 조작·모델 정책 변경·로그인)을
 * `await insert(...)`만 하거나 `try/catch`로 감싸면 **표가 없거나 칸이 어긋나도 조용히 사라진다** — 운영 DB에 `security_logs`가 없어
 * 보안 로그가 통째로 버려졌던 일(0097)이 그 꼴이다. 이 함수는 돌려준 오류와 던진 예외를 모두 실패로 보고 `system_logs`(security, error)에
 * 표·종류·오류 코드만 남긴다(사람·상세 없음). 부른 일을 되돌리지 않도록 던지지 않는다.
 * 보안 로그는 `logSecurityEvent`(security-log.ts), 사용 기록은 `writeUsageLog`가 같은 일을 한다.
 */

export type AuditTable = 'super_admin_logs' | 'model_policy_logs' | 'access_logs';

export interface AuditWriteDeps {
  insert(table: AuditTable, row: Record<string, unknown>): Promise<{ error: { code?: string } | null }>;
  report(table: AuditTable, kind: string, code: string): Promise<void>;
}

const defaultDeps = (): AuditWriteDeps => ({
  insert: async (table, row) => {
    const { error } = await supabaseAdmin.from(table).insert(row);
    return { error };
  },
  report: (table, kind, code) =>
    logSystem({ level: 'error', category: 'security', message: '감사 기록을 남기지 못했습니다', details: { table, kind, code } }),
});

/** 남겼으면 true. 던지지 않는다. `kind`는 운영 기록에 남길 짧은 종류 이름(행의 action 등) */
export async function writeAuditRow(table: AuditTable, row: Record<string, unknown>, kind: string, deps: AuditWriteDeps = defaultDeps()): Promise<boolean> {
  let code: string;
  try {
    const { error } = await deps.insert(table, row);
    if (!error) return true;
    code = error.code ?? 'error';
  } catch {
    code = 'exception';
  }
  console.error('[audit] 기록 실패:', table, kind, code);
  await deps.report(table, kind, code).catch(() => {});
  return false;
}
