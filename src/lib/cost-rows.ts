/**
 * 슈퍼관리자 화면의 '원가'는 모든 활동의 사용 기록으로 센다(2026-11-19).
 *
 * 예전 대시보드 '예상 비용'·계약 '월별 매출 / API 비용'·사용량·기관 상세 사용량은 `chat_message`만 읽어,
 * 업무 작업(`work_generate`·`work_revise`)·답변 평가(`rag_eval_*`)·프롬프트 다듬기·태그 초안·근거로 고쳐 쓰기·
 * 대화 제목 같은 모델 호출의 원가가 빠졌다 — 예산 판정(`organization_spend_krw`)은 모든 활동을 센다.
 * 대화 수·토큰(한도 판정과 같은 셈 — `organization_chat_tokens`)은 그대로 `chat_message`만.
 *
 * 아무것도 import하지 않는다.
 */
export const CHAT_ACTION = 'chat_message';

export function isChatRow(row: { action?: unknown }): boolean {
  return row.action === CHAT_ACTION;
}

/** 숫자만(글자 값이 이어 붙어 합계가 망가지지 않게) */
export function tokenNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
