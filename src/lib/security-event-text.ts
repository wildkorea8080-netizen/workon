// src/lib/security-event-text.ts
// 감사 화면 '보안 이벤트'의 상세 한 줄(2026-11-18) — 아무것도 import하지 않는다.
//
// 예전 상세는 심각도와 탐지어뿐이라, '계정 사용 중지(관리자)'·'임시 비밀번호 재발급(관리자)' 같은 줄에 **누구를 대상으로 했는지**가 없었다.
// 감사에서 묻는 것은 "누가 누구에게 무엇을 했는가"다. 기록에는 대상 id·사유·전후 값이 이미 있으므로 읽을 말로 푼다.
// 질문 글(금지어 기록의 `context`)·패턴 원문은 싣지 않는다 — 질문 원문은 사유를 적고 열람하는 길이 따로 있다.

/**
 * 보안 사건 종류 → 한국어(감사 화면 '보안 이벤트'·관리자 설정 화면 '보안 이벤트 로그'가 함께 쓴다).
 * 열쇠는 실제로 남는 사건 종류(`SecurityEventType`)와 같아야 한다 — 새 종류를 더하면 여기도(`tests/batch-0157.test.ts`).
 */
export const SECURITY_EVENT_LABELS: Record<string, string> = {
  query_revealed: '질문 원문 열람',
  app_webhook_revoked: '앱 연동 회수(관리자)',
  app_schedule_paused: '앱 예약 멈춤(관리자)',
  app_schedule_unlocked: '앱 예약 잠금 풀기(관리자)',
  sign_in_unlocked: '로그인 잠금 풀기(관리자)',
  password_changed: '비밀번호 바꾸기(본인)',
  password_reset_by_admin: '임시 비밀번호 재발급(관리자)',
  password_reset_by_email: '비밀번호 재설정(메일 링크)',
  user_deactivated: '계정 사용 중지(관리자)',
  user_reactivated: '계정 다시 사용(관리자)',
  user_dormant_locked: '장기 미접속으로 사용 중지(자동)',
  dormant_lock_changed: '장기 미접속 잠금 설정 바꾸기(관리자)',
  user_role_changed: '직원 권한 바꾸기(관리자)',
  user_department_changed: '직원 부서 옮기기(관리자)',
  user_budget_changed: '개인 월 한도 바꾸기(관리자)',
  user_invited: '직원 초대(관리자)',
  user_invite_canceled: '직원 초대 취소(관리자)',
  user_created: '계정 만들기(관리자)',
  users_bulk_created: '직원 일괄 등록(관리자)',
  org_access_ips_changed: '접속 허용 IP 바꾸기(관리자)',
  organization_updated: '기관 정보 바꾸기(관리자)',
  department_created: '부서 만들기(관리자)',
  department_updated: '부서 고치기(관리자)',
  department_deleted: '부서 삭제(관리자)',
  app_batch_stopped: '앱 일괄 실행 멈춤(관리자)',
  app_batch_limit_changed: '앱 일괄 실행 상한 바꾸기(관리자)',
  app_outbound_result_retried: '앱 결과 다시 보내기(직원)',
  app_webhooks_org_disabled: '기관 외부 연동 끄기(관리자)',
  app_webhooks_org_enabled: '기관 외부 연동 켜기(관리자)',
  app_schedules_org_disabled: '기관 앱 예약 끄기(관리자)',
  app_schedules_org_enabled: '기관 앱 예약 켜기(관리자)',
  org_api_key_created: '기관 통계 API 키 만들기(관리자)',
  org_api_key_revoked: '기관 통계 API 키 회수(관리자)',
  app_outbound_endpoint_created: '앱 결과 보낼 곳 만들기(관리자)',
  app_outbound_endpoint_revoked: '앱 결과 보낼 곳 회수(관리자)',
  app_outbound_endpoint_updated: '앱 결과 보낼 곳 — 보내기 전 확인 바꾸기(관리자)',
  app_outbound_result_approved: '앱 결과 보내기 확인(직원)',
  app_outbound_result_rejected: '앱 결과 보내지 않기(직원)',
  // 실제로 남는 사건 종류(`SecurityEventType`)와 같은 열쇠여야 한다 — 예전 열쇠(forbidden_word·personal_info·blocked_upload·rate_limit)는
  // 어느 기록과도 맞지 않아 가장 흔한 금지어·개인정보 감지가 코드 그대로 보였다(2026-11-18, `tests/batch-0157.test.ts`가 빠진 종류를 막음)
  forbidden_word_detected: '금지어 감지',
  personal_info_detected: '개인정보 패턴 감지',
  file_upload_blocked: '업로드 차단',
  suspicious_content: '의심스러운 내용 감지',
  rate_limit_exceeded: '요청 제한',
  ip_blocked: '접속 허용 IP 밖 접속 차단',
  preset_agents_installed: '기본 비서·앱 세트 설치(관리자)',
  preset_agents_updated: '기본 비서·앱 세트 갱신(관리자)',
};

export const SECURITY_SEVERITY_LABELS: Record<string, string> = {
  low: '낮음',
  medium: '보통',
  high: '높음',
  critical: '심각',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clean = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '';

const ROLE_LABEL: Record<string, string> = { ADMIN: '관리자', USER: '일반 직원' };
const roleText = (v: unknown) => (typeof v === 'string' ? ROLE_LABEL[v] ?? clean(v, 20) : '(모름)');

/** 개인 월 한도 — 비어 있으면 부서 기본값을 따른다 */
const budgetText = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? `${Math.round(v).toLocaleString('ko-KR')}원` : '부서 기본값';

/** 부서 월 한도·1인당 월 한도(기본값) — 비어 있으면 제한 없음 */
const limitText = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? `${Math.round(v).toLocaleString('ko-KR')}원` : '제한 없음';

/** 상위 부서 — id가 없으면 최상위, 이름을 못 읽었으면 '(이름 모름)' */
const parentText = (id: unknown, name: unknown) => (id ? clean(name, 40) || '(이름 모름)' : '(최상위)');

/**
 * 기록의 `details`에서 감사 화면에 보일 조각들. `nameOf`는 관리 범위 안 직원의 이름(없으면 null) —
 * 범위 밖 사람의 이름은 내보내지 않는다.
 */
export function securityDetailParts(details: unknown, nameOf: (userId: string) => string | null): string[] {
  if (!details || typeof details !== 'object') return [];
  const d = details as Record<string, unknown>;
  const parts: string[] = [];

  const word = clean(d.word, 40);
  if (word) parts.push(`탐지어: ${word}`);

  // 개인정보 패턴 감지 — 걸린 글은 기록에 없다(몇 곳인지만). 규칙 원문(정규식)은 보이지 않는다
  if (typeof d.matches === 'number' && Number.isFinite(d.matches) && d.matches > 0) {
    parts.push(`개인정보 꼴 ${Math.round(d.matches)}곳`);
  }

  if (typeof d.target_user_id === 'string' && d.target_user_id) {
    const target = UUID.test(d.target_user_id)
      ? nameOf(d.target_user_id) ?? '(관리 범위 밖이거나 삭제된 계정)'
      : clean(d.target_user_id, 40);
    if (target) parts.push(`대상: ${target}`);
  }

  const invited = clean(d.invited_email, 100);
  if (invited) parts.push(`초대: ${invited}${typeof d.invited_role === 'string' ? ` (${roleText(d.invited_role)})` : ''}`);

  if ('from_role' in d || 'to_role' in d) parts.push(`권한: ${roleText(d.from_role)} → ${roleText(d.to_role)}`);

  // ── 계정 만들기·일괄 등록 (2026-11-18) ──
  if (typeof d.created_role === 'string') parts.push(`만든 권한: ${roleText(d.created_role)}`);

  if (typeof d.created_count === 'number' && Number.isFinite(d.created_count)) {
    const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
    const bits = [`등록 ${count(d.created_count)}명`];
    if (count(d.created_admins)) bits.push(`관리자 ${count(d.created_admins)}명`);
    if (count(d.created_departments)) bits.push(`새 부서 ${count(d.created_departments)}개`);
    if (count(d.failed_count)) bits.push(`실패 ${count(d.failed_count)}줄`);
    parts.push(bits.join(' · '));
  }

  if (d.via === 'bulk_register') parts.push('일괄 등록으로');

  // ── 접속 허용 IP·기관 정보 (2026-11-18) ──
  if ('from_ips' in d || 'to_ips' in d) {
    const ips = (v: unknown, n: unknown) => {
      const list = Array.isArray(v) ? v.map((x) => clean(x, 50)).filter(Boolean) : [];
      if (list.length === 0) return '제한 없음';
      const total = typeof n === 'number' && n > list.length ? n : list.length;
      const shown = list.slice(0, 5).join(', ');
      return total > Math.min(list.length, 5) ? `${shown} 외 ${total - Math.min(list.length, 5)}개` : shown;
    };
    parts.push(`접속 허용 IP: ${ips(d.from_ips, d.from_ip_count)} → ${ips(d.to_ips, d.to_ip_count)}`);
  }

  if ('from_org_name' in d || 'to_org_name' in d) {
    parts.push(`기관명: ${clean(d.from_org_name, 60) || '(없음)'} → ${clean(d.to_org_name, 60) || '(없음)'}`);
  }

  if ('from_slug' in d || 'to_slug' in d) {
    parts.push(`로그인 경로: ${clean(d.from_slug, 40) || '(없음)'} → ${clean(d.to_slug, 40) || '(없음)'}`);
  }

  if (Array.isArray(d.changed_fields)) {
    const FIELD: Record<string, string> = { ai_notice: 'AI 고지 문구', theme_color: '테마 색', logo: '로고' };
    const names = d.changed_fields.map((f) => (typeof f === 'string' ? FIELD[f] : '')).filter(Boolean);
    if (names.length > 0) parts.push(`바꾼 것: ${names.join(', ')}`);
  }

  if ('from_department_id' in d || 'to_department_id' in d) {
    const from = clean(d.from_department_name, 40) || '(이름 모름)';
    const to = clean(d.to_department_name, 40) || '(이름 모름)';
    parts.push(`부서: ${from} → ${to}`);
  }

  // ── 부서 만들기·고치기·삭제 (2026-11-18) ──
  const deptName = clean(d.dept_name, 40);
  if (deptName) parts.push(`대상 부서: ${deptName}`);

  if ('from_dept_name' in d || 'to_dept_name' in d) {
    parts.push(`부서명: ${clean(d.from_dept_name, 40) || '(이름 모름)'} → ${clean(d.to_dept_name, 40) || '(이름 모름)'}`);
  }

  if ('from_parent_id' in d || 'to_parent_id' in d) {
    parts.push(`상위 부서: ${parentText(d.from_parent_id, d.from_parent_name)} → ${parentText(d.to_parent_id, d.to_parent_name)}`);
  } else if ('parent_id' in d) {
    parts.push(`상위 부서: ${parentText(d.parent_id, d.parent_name)}`);
  }

  if ('from_dept_budget_krw' in d || 'to_dept_budget_krw' in d) {
    parts.push(`부서 월 한도: ${limitText(d.from_dept_budget_krw)} → ${limitText(d.to_dept_budget_krw)}`);
  }

  if ('from_user_default_budget_krw' in d || 'to_user_default_budget_krw' in d) {
    parts.push(`1인당 월 한도(부서 기본값): ${limitText(d.from_user_default_budget_krw)} → ${limitText(d.to_user_default_budget_krw)}`);
  }

  if ('from_budget_krw' in d || 'to_budget_krw' in d) {
    parts.push(`개인 월 한도: ${budgetText(d.from_budget_krw)} → ${budgetText(d.to_budget_krw)}`);
  }

  if (d.impersonating === true) parts.push('대리 접근 중');

  const reason = clean(d.reason, 100);
  if (reason) parts.push(`사유: ${reason}`);

  return parts;
}
