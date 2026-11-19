/**
 * 기관 상태 — 이용을 멈춘 상태인가(2026-11-19).
 *
 * `organizations.status`는 'trial' | 'active' | 'suspended'(정지) | 'terminated'(종료, 슈퍼관리자 '기관 종료').
 * 예전에는 대화 한도 판정·문서 올리기·예산 알림이 'suspended'만 보아, **종료한 기관의 직원이 AI를 계속 쓰고
 * 문서를 올리고 예산 알림 메일을 받았다.** 멈춘 상태의 판정은 이 한 곳에서 한다.
 *
 * 아무것도 import하지 않는다(화면·서버 공용).
 */
export const STOPPED_ORG_STATUSES = ['suspended', 'terminated'] as const;

/** 이용을 멈춘 기관인가 — 정지·종료 */
export function isStoppedOrgStatus(status: unknown): boolean {
  return status === 'suspended' || status === 'terminated';
}

/** PostgREST `.not('status', 'in', …)`에 넣는 꼴 */
export const STOPPED_ORG_STATUS_LIST = `(${STOPPED_ORG_STATUSES.join(',')})`;

/** 슈퍼관리자 화면의 상태 이름(2026-11-19 — 예전 화면은 'suspended'만 알아 종료한 기관을 '활성'으로 보였다) */
const ORG_STATUS_LABELS: Record<string, string> = { trial: '체험', active: '활성', suspended: '정지', terminated: '종료' };

export function orgStatusLabel(status: unknown): string {
  return typeof status === 'string' && Object.prototype.hasOwnProperty.call(ORG_STATUS_LABELS, status)
    ? ORG_STATUS_LABELS[status]
    : '알 수 없음';
}

/** 정지하기 전에 묻는 글 — 정지하면 그 기관 직원 모두가 대화·문서 올리기를 못 한다 */
export function orgSuspendConfirmText(orgName: string): string {
  return `'${orgName}' 기관을 정지할까요? 그 기관의 모든 직원이 AI 대화와 문서 올리기를 할 수 없게 됩니다.`;
}

export type OrgStatusChangeNotice = { ok: boolean; message: string };

/**
 * 상태 바꾸기(`PATCH /api/super/organizations/[id]`)의 응답을 알림 글로. 예전 화면 셋 중 둘은 응답을 보지 않고
 * '기관이 정지됐습니다'를 띄웠고, 하나는 실패하면 아무 말이 없었다. 계약을 맞추지 못한 경고(`warning`)가 있으면 그것을.
 */
export function orgStatusChangeNotice(status: string, httpOk: boolean, body: unknown): OrgStatusChangeNotice {
  const b = body && typeof body === 'object' ? (body as { ok?: unknown; error?: unknown; warning?: unknown }) : null;
  if (!httpOk || b?.ok !== true) {
    const e = b?.error;
    const text = typeof e === 'string' ? e
      : e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string' ? (e as { message: string }).message
      : '';
    return { ok: false, message: text || '기관 상태를 바꾸지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  }
  if (typeof b.warning === 'string' && b.warning) return { ok: true, message: b.warning };
  const done = status === 'suspended' ? '기관이 정지됐습니다.'
    : status === 'terminated' ? '기관이 종료됐습니다.'
    : '기관이 활성화됐습니다.';
  return { ok: true, message: done };
}

/** 상태를 바꾸고 알림 글을 돌려준다 — 연결이 끊겨도 던지지 않는다 */
export async function requestOrgStatusChange(
  orgId: string,
  status: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OrgStatusChangeNotice> {
  try {
    const res = await fetchImpl(`/api/super/organizations/${encodeURIComponent(orgId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    const body = await res.json().catch(() => null);
    return orgStatusChangeNotice(status, res.ok, body);
  } catch {
    return orgStatusChangeNotice(status, false, null);
  }
}
