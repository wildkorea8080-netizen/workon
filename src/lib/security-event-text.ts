// src/lib/security-event-text.ts
// 감사 화면 '보안 이벤트'의 상세 한 줄(2026-11-18) — 아무것도 import하지 않는다.
//
// 예전 상세는 심각도와 탐지어뿐이라, '계정 사용 중지(관리자)'·'임시 비밀번호 재발급(관리자)' 같은 줄에 **누구를 대상으로 했는지**가 없었다.
// 감사에서 묻는 것은 "누가 누구에게 무엇을 했는가"다. 기록에는 대상 id·사유·전후 값이 이미 있으므로 읽을 말로 푼다.
// 질문 글(금지어 기록의 `context`)·패턴 원문은 싣지 않는다 — 질문 원문은 사유를 적고 열람하는 길이 따로 있다.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clean = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '';

const ROLE_LABEL: Record<string, string> = { ADMIN: '관리자', USER: '일반 직원' };
const roleText = (v: unknown) => (typeof v === 'string' ? ROLE_LABEL[v] ?? clean(v, 20) : '(모름)');

/** 개인 월 한도 — 비어 있으면 부서 기본값을 따른다 */
const budgetText = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? `${Math.round(v).toLocaleString('ko-KR')}원` : '부서 기본값';

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

  if (typeof d.target_user_id === 'string' && d.target_user_id) {
    const target = UUID.test(d.target_user_id)
      ? nameOf(d.target_user_id) ?? '(관리 범위 밖이거나 삭제된 계정)'
      : clean(d.target_user_id, 40);
    if (target) parts.push(`대상: ${target}`);
  }

  if ('from_role' in d || 'to_role' in d) parts.push(`권한: ${roleText(d.from_role)} → ${roleText(d.to_role)}`);

  if ('from_department_id' in d || 'to_department_id' in d) {
    const from = clean(d.from_department_name, 40) || '(이름 모름)';
    const to = clean(d.to_department_name, 40) || '(이름 모름)';
    parts.push(`부서: ${from} → ${to}`);
  }

  if ('from_budget_krw' in d || 'to_budget_krw' in d) {
    parts.push(`개인 월 한도: ${budgetText(d.from_budget_krw)} → ${budgetText(d.to_budget_krw)}`);
  }

  if (d.impersonating === true) parts.push('대리 접근 중');

  const reason = clean(d.reason, 100);
  if (reason) parts.push(`사유: ${reason}`);

  return parts;
}
