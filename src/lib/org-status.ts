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
