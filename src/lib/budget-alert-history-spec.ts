// src/lib/budget-alert-history-spec.ts
// 예산 알림 이력(2026-11-26) — 관리자 '기관 정보' 화면의 '예산 알림 이력'이 보이는 꼴. 잎 파일(화면과 라우트가 함께 쓴다, 아무것도 가져오지 않음).
//
// 예산 알림 메일(0045·0052)은 보냈는지가 `budget_alerts`에만 남고 보는 화면이 없었다 — 관리자는 메일을 못 받았을 때(받는 사람 없음·보내기 실패)
// 알 길이 없었다. 기관 알림은 관리자 누구나(예산 현황과 같이), 부서 알림은 관리 범위 부서만, **개인 월 한도 알림은 싣지 않는다**(직원 본인에게만 가는 메일).

/** 보내기를 해 보는 횟수 — `budget-alerts.ts`의 `MAX_ALERT_ATTEMPTS`와 같다(시험이 맞댄다) */
export const BUDGET_ALERT_HISTORY_ATTEMPTS = 3;
/** 한 번에 보이는 줄 수 */
export const BUDGET_ALERT_HISTORY_LIMIT = 100;

export const BUDGET_ALERT_KIND_LABELS: Record<string, string> = {
  annual_budget: '연간 정액 예산',
  monthly_tokens: '월 토큰 한도',
  department_monthly: '부서 월 한도',
};

export type BudgetAlertRow = {
  id: string; subject: string; period_key: string; threshold: number; kind: string; status: string;
  attempts: number; percent: number; recipients: number; created_at: string; updated_at: string;
};

export type BudgetAlertView = {
  id: string;
  target: 'organization' | 'department';
  departmentId: string | null;
  departmentName: string | null;
  kindLabel: string;
  periodLabel: string;
  threshold: number;
  percent: number;
  status: string;
  statusLabel: string;
  recipients: number;
  createdAt: string;
  updatedAt: string;
};

/** 이 관리자에게 보일 대상인가 — 기관은 누구나, 부서는 관리 범위만, 개인·모르는 꼴은 아님 */
export function visibleAlertTarget(subject: string, managed: Set<string>): { target: 'organization' | 'department'; departmentId: string | null } | null {
  if (subject === 'org') return { target: 'organization', departmentId: null };
  const m = /^dept:([0-9a-f-]{36})$/i.exec(subject);
  if (m && managed.has(m[1].toLowerCase())) return { target: 'department', departmentId: m[1].toLowerCase() };
  return null;
}

/** 기간 열쇠 → 글. 달은 `2026년 11월`, 연간 계약은 '계약 기간' */
export function budgetPeriodLabel(key: string): string {
  const m = /^month:(\d{4})-(\d{2})$/.exec(key);
  if (m) return `${m[1]}년 ${Number(m[2])}월`;
  if (key.startsWith('contract:')) return '계약 기간';
  return '—';
}

/** 상태 글 — 실패는 해 본 횟수와 다시 해 볼지, 보내는 중은 멈춘 차지일 수 있음을 */
export function budgetAlertStatusLabel(status: string, attempts: number): string {
  if (status === 'sent') return '보냄';
  if (status === 'no_recipients') return '받는 사람 없음 — 보내지 않음';
  if (status === 'sending') return '보내는 중';
  if (status === 'failed') {
    return attempts >= BUDGET_ALERT_HISTORY_ATTEMPTS
      ? `못 보냄(${attempts}번 해 봄 — 더 해 보지 않음)`
      : `못 보냄(${attempts}번 해 봄 — 다음 확인 때 다시)`;
  }
  return status;
}

export function budgetAlertView(row: BudgetAlertRow, managed: Set<string>, deptNames: Map<string, string>): BudgetAlertView | null {
  const target = visibleAlertTarget(row.subject, managed);
  if (!target) return null;
  return {
    id: row.id,
    target: target.target,
    departmentId: target.departmentId,
    departmentName: target.departmentId ? deptNames.get(target.departmentId) ?? null : null,
    kindLabel: BUDGET_ALERT_KIND_LABELS[row.kind] ?? row.kind,
    periodLabel: budgetPeriodLabel(row.period_key),
    threshold: row.threshold,
    percent: row.percent,
    status: row.status,
    statusLabel: budgetAlertStatusLabel(row.status, row.attempts),
    recipients: row.recipients,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 기관 예산 알림을 더 받을 주소(0135) — 기관 전체 관리자가 정한다 */
export const BUDGET_ALERT_EXTRA_MAX = 5;
const EMAIL_RE = /^[^\s@<>"',]+@[^\s@<>"',]+\.[^\s@<>"',]+$/;
/** 주소 목록 검사 — 다듬어 소문자·겹침 없이, 꼴이 틀리거나 5개를 넘으면 까닭 글 */
export function parseBudgetAlertEmails(raw: unknown): { ok: true; emails: string[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) return { ok: false, message: '주소를 목록으로 보내 주세요.' };
  const emails = [...new Set(raw.map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : '')).filter(Boolean))];
  const bad = emails.find((e) => e.length > 200 || !EMAIL_RE.test(e));
  if (bad !== undefined) return { ok: false, message: `메일 주소를 확인해 주세요: ${bad.slice(0, 60)}` };
  if (emails.length > BUDGET_ALERT_EXTRA_MAX) return { ok: false, message: `주소는 ${BUDGET_ALERT_EXTRA_MAX}개까지 더할 수 있습니다.` };
  return { ok: true, emails };
}
