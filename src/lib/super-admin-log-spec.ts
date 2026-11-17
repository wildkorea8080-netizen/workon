/**
 * 슈퍼관리자 조작 기록(`super_admin_logs`)을 화면 글로(2026-11-17) — 잎 파일(화면·서버 공용, 아무것도 import하지 않음).
 *
 * 기관 등록·정지·계정 삭제·비밀번호 재발급·잠금 풀기·시스템 설정 변경 등을 `writeAuditRow('super_admin_logs', …)`로 남겨 왔지만
 * **이 표를 읽는 곳이 하나도 없었다** — 시스템 설정 '최근 슈퍼관리자 활동 이력'은 없는 주소(`/api/super/logs`)를 불러 늘 비어 있었다.
 * 읽기는 `GET /api/super/logs/admin`, 화면은 로그 관리 '관리자 조작' 탭과 시스템 설정 보안 탭.
 * 요약 글은 기록에 든 값 중 사람이 알아볼 몇 칸만 짧게 — 기록 전체(jsonb)를 화면에 쏟지 않는다.
 */

export const ADMIN_LOG_ACTIONS: Record<string, string> = {
  org_created: '기관 등록',
  org_updated: '기관 정보 수정',
  org_suspended: '기관 정지',
  user_updated: '계정 사용·권한 변경',
  user_deleted: '계정 삭제(탈퇴 처리)',
  password_reset: '비밀번호 재발급',
  sign_in_unlocked: '로그인 잠금 풀기',
  sign_in_ip_unlocked: 'IP 로그인 잠금 풀기',
  super_admin_created: '슈퍼관리자 추가',
  super_admin_updated: '슈퍼관리자 사용 변경',
  system_setting_changed: '시스템 설정 변경',
  work_settings_changed: '업무 화면 전환',
  common_document_uploaded: '공통 문서 올림',
  common_document_deleted: '공통 문서 지움',
  // 0006 주석에 적힌 옛 값
  contract_updated: '계약 변경',
  api_key_rotated: 'API 키 교체',
  billing_finalized: '정산 확정',
  user_impersonated: '대리 접근',
};

export const ADMIN_LOG_TARGETS: Record<string, string> = {
  organization: '기관',
  user: '계정',
  ip: 'IP',
  system_setting: '시스템 설정',
  common_document: '공통 문서',
  contract: '계약',
  api_key: 'API 키',
  billing_log: '정산',
};

/** 거르기 값으로 받을 수 있는 종류인가 — 영문 소문자·밑줄 40자 */
export function isAdminLogAction(v: string | null | undefined): v is string {
  return typeof v === 'string' && /^[a-z_]{1,40}$/.test(v);
}

export const adminLogActionLabel = (a: string): string => ADMIN_LOG_ACTIONS[a] ?? a;
export const adminLogTargetLabel = (t: string | null | undefined): string => (t ? ADMIN_LOG_TARGETS[t] ?? t : '—');

type Data = Record<string, unknown> | null | undefined;

const SUMMARY_MAX = 160;

function clip(v: unknown, n = 60): string {
  const s = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : v == null ? '' : JSON.stringify(v);
  // 줄바꿈·제어 글자는 한 칸 공백으로
  const one = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

function obj(d: unknown): Record<string, unknown> | null {
  return d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : null;
}

const activeText = (v: unknown) => (v === true ? '사용' : v === false ? '사용 중지' : clip(v));

/** 기록 한 줄의 짧은 설명 — 값이 없으면 빈 글 */
export function adminLogSummary(action: string, beforeData: unknown, afterData: unknown): string {
  const b: Data = obj(beforeData);
  const a: Data = obj(afterData);
  const parts: string[] = [];
  const has = (d: Data, k: string) => !!d && Object.prototype.hasOwnProperty.call(d, k);

  if (action === 'system_setting_changed' && a) {
    parts.push(`${clip(a.key, 40)}: ${clip(b?.value ?? '(없음)')} → ${clip(a.value)}`);
  } else if (action === 'common_document_uploaded' || action === 'common_document_deleted') {
    const d = a ?? b;
    if (d) parts.push(`${clip(d.title)}${d.edition_year ? `(${clip(d.edition_year, 4)})` : ''}`);
  } else if (action === 'sign_in_ip_unlocked' && a) {
    parts.push(`${clip(a.ip, 45)} · 실패 기록 ${clip(a.cleared, 6)}건 지움`);
  } else if (action === 'password_reset' && a) {
    parts.push(a.email_sent === true ? '안내 메일 보냄' : '메일 안 보냄 — 화면으로 전달');
  } else {
    if (a && has(a, 'name')) parts.push(clip(a.name));
    if (a && has(a, 'plan')) parts.push(`요금제 ${clip(a.plan, 20)}`);
    if (b && has(b, 'email') && !has(a, 'email')) parts.push(clip(b.email));
    if (a && has(a, 'email')) parts.push(clip(a.email));
    if (has(a, 'is_active')) parts.push(`${has(b, 'is_active') ? `${activeText(b!.is_active)} → ` : ''}${activeText(a!.is_active)}`);
    if (has(a, 'role')) parts.push(`권한 ${has(b, 'role') ? `${clip(b!.role, 10)} → ` : ''}${clip(a!.role, 10)}`);
    if (has(a, 'status')) parts.push(`상태 ${has(b, 'status') ? `${clip(b!.status, 12)} → ` : ''}${clip(a!.status, 12)}`);
    if (has(a, 'homeEnabled')) parts.push(`업무 홈 ${a!.homeEnabled ? '켬' : '끔'}`);
    if (has(a, 'newTasksEnabled')) parts.push(`새 작업 ${a!.newTasksEnabled ? '켬' : '끔'}`);
  }
  const s = parts.filter(Boolean).join(' · ');
  return s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX)}…` : s;
}

/** `GET /api/super/logs/admin`의 한 줄 */
export interface AdminLogRow {
  id: string;
  createdAt: string;
  action: string;
  actionLabel: string;
  targetType: string | null;
  targetLabel: string;
  targetId: string | null;
  targetName: string | null;
  summary: string;
  adminEmail: string;
  adminName: string;
  ipAddress: string | null;
}
