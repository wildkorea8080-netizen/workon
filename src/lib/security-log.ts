import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logSystem } from '@/lib/logger';

/**
 * 보안 감사 로그 쓰기 — 한 곳(2026-11-17).
 *
 * 운영 DB에 `security_logs` 표가 없던 동안(0097로 메움) 모든 보안 로그가 **조용히** 사라졌다. Supabase 클라이언트는 실패를 던지지 않고
 * `{ error }`로 돌려주는데, 쓰던 곳마다 `try { await insert(...) } catch {}`로 감싸 오류를 보지 않았기 때문이다.
 * 이제 보안 로그는 이 함수로만 쓴다(`tests/batch-0117.test.ts`가 다른 곳의 직접 insert를 막는다). 실패해도 부른 일을 되돌리지 않지만
 * `system_logs`(security, error)에 사건 종류·오류 코드만 남겨 운영자가 본다(상세·사람은 싣지 않음 — 그 기록이 또 실패할 수 있으니 던지지 않는다).
 */

export type SecurityEventType =
  | 'forbidden_word_detected'
  | 'personal_info_detected'
  | 'file_upload_blocked'
  | 'suspicious_content'
  | 'rate_limit_exceeded'
  /** 관리자가 감사 화면에서 직원 질문 원문을 열람함 (D1) */
  | 'query_revealed'
  /** 관리자가 직원의 앱 연동을 회수함 / 예약을 멈춤(잠금) / 잠금을 풂 (0050) */
  | 'app_webhook_revoked'
  | 'app_schedule_paused'
  | 'app_schedule_unlocked'
  /** 관리자가 직원의 앱 일괄 실행을 멈춤 (2026-11-10) */
  | 'app_batch_stopped'
  /** 기관 전체 관리자가 일괄 실행 한 번 최대 줄 수를 바꿈 (0084) */
  | 'app_batch_limit_changed'
  /** 직원이 그만둔 앱 결과 보내기를 다시 보냄 (2026-11-10) */
  | 'app_outbound_result_retried'
  | 'app_webhooks_org_disabled'
  | 'app_webhooks_org_enabled'
  | 'app_schedules_org_disabled'
  | 'app_schedules_org_enabled'
  /** 기관 전체 관리자가 기관 통계 API 키를 만듦 / 회수함 (0075) */
  | 'org_api_key_created'
  | 'org_api_key_revoked'
  /** 기관 API 키(범위 documents_write)로 비서 문서함에 문서를 올림 (0100) */
  | 'org_api_document_uploaded'
  /** 기관 API 키(범위 documents_delete)로 비서 문서함의 문서를 지움 (0104) */
  | 'org_api_document_deleted'
  | 'org_api_chat_started'
  /** 기관 전체 관리자가 앱 결과를 보낼 곳을 만듦 / 회수함 (0076) */
  | 'app_outbound_endpoint_created'
  | 'app_outbound_endpoint_revoked'
  | 'app_outbound_endpoint_updated'
  | 'app_outbound_result_approved'
  | 'app_outbound_result_rejected'
  /** 기관 접속 허용 IP에 막힘 (0023) */
  | 'ip_blocked'
  /** 기본 비서·앱 세트 설치·갱신 (2026-11-07) */
  | 'preset_agents_installed'
  | 'preset_agents_updated'
  /** 인증·계정 (2026-11-16) */
  | 'sign_in_unlocked'
  | 'password_changed'
  | 'password_reset_by_admin'
  | 'password_reset_by_email'
  | 'user_deactivated'
  | 'user_reactivated'
  | 'user_dormant_locked'
  | 'dormant_lock_changed'
  /** 기관 SSO(OIDC) 설정 바꾸기 (0107) */
  | 'org_sso_changed'
  /** 기관 관리자가 직원의 권한 / 부서 / 개인 월 한도를 바꿈 (2026-11-18 — 그 전에는 어디에도 남지 않았다) */
  | 'user_role_changed'
  | 'user_department_changed'
  /** 기관 계정(SSO)으로 로그인할 때 계정 서비스의 그룹에 맞춰 부서를 옮김 (0110) */
  | 'user_department_synced'
  /** 기관 계정(SSO)으로 로그인할 때 계정 서비스의 관리자 그룹에 맞춰 관리자로 올리거나 내림 (0115) */
  | 'user_role_synced'
  /** 기관 전체 관리자가 공유 자료함을 만들거나 고치거나 지움 (0116) */
  | 'library_share_changed'
  | 'sso_backchannel_logout'
  | 'user_budget_changed'
  /** 기관 관리자가 직원을 초대함 / 초대를 취소함 (2026-11-18) */
  | 'user_invited'
  | 'user_invite_canceled'
  /** 기관 관리자가 부서를 만듦 / 고침(이름·상위 부서·월 한도) / 지움 (2026-11-18 — 그 전에는 어디에도 남지 않았다) */
  | 'department_created'
  | 'department_updated'
  | 'department_deleted'
  /** 기관 관리자가 계정을 바로 만듦(직원 등록) / CSV 일괄 등록 (2026-11-18) */
  | 'user_created'
  | 'users_bulk_created'
  /** 기관 전체 관리자가 접속 허용 IP를 바꿈 / 기관 정보(기관명·로그인 경로·AI 고지·테마 색·로고)를 바꿈 (2026-11-18) */
  | 'org_access_ips_changed'
  | 'organization_updated'
  /** 직원이 대화를 로그인 없이 볼 수 있는 링크로 공유함 / 공유를 멈춤 (2026-11-18) */
  | 'conversation_shared'
  | 'conversation_unshared'
  /** 기관 관리자가 직원의 대화 공개 링크를 멈춤 (2026-11-18) */
  | 'conversation_unshared_by_admin'
  /** 기관 전체 관리자가 대화 공개 링크 기능을 막음 / 다시 엶 (0098, 2026-11-23) */
  | 'conversation_share_org_disabled'
  | 'conversation_share_org_enabled';

export type SecuritySeverity = 'low' | 'medium' | 'high' | 'critical';

export interface SecurityLogDeps {
  insert(row: Record<string, unknown>): Promise<{ error: { code?: string; message?: string } | null }>;
  report(eventType: string, code: string): Promise<void>;
}

const defaultDeps = (): SecurityLogDeps => ({
  insert: async (row) => {
    const { error } = await supabaseAdmin.from('security_logs').insert(row);
    return { error };
  },
  report: (eventType, code) =>
    logSystem({ level: 'error', category: 'security', message: '보안 로그를 남기지 못했습니다', details: { event_type: eventType, code } }),
});

/** 보안 로그 한 줄 — 남겼으면 true. 던지지 않는다 */
export async function logSecurityEvent(
  departmentId: string | null | undefined,
  userId: string | null | undefined,
  eventType: SecurityEventType,
  details: Record<string, unknown> = {},
  severity: SecuritySeverity = 'medium',
  deps: SecurityLogDeps = defaultDeps(),
): Promise<boolean> {
  let code: string | null = null;
  try {
    const { error } = await deps.insert({
      department_id: departmentId ?? null,
      user_id: userId ?? null,
      event_type: eventType,
      details,
      severity,
      created_at: new Date().toISOString(),
    });
    if (!error) return true;
    code = error.code ?? 'error';
  } catch {
    code = 'exception';
  }
  console.error('[security-log] 기록 실패:', eventType, code);
  await deps.report(eventType, code).catch(() => {});
  return false;
}
