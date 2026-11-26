// src/lib/apps/run-cause.ts
// 입력형 앱 실행이 멈춘 까닭(2026-11-26) — 멈춘 단계 기록에 남기는 정해 둔 코드와 이름표. 잎 파일(화면·실행기·집계가 함께 쓴다, 아무것도 가져오지 않음).
//
// 예전에는 단계 기록에 실패 상태만 있어 관리자 '앱 실행 현황'이 어느 단계에서 멈췄는지만 보였다 — 시간이 모자랐는지, 한도였는지, AI 서비스였는지 몰랐다.
// 오류 원문은 남기지 않는다(입력·결과 글이 섞일 수 있고, 관리자 집계에 원문을 싣지 않는 규칙 그대로) — 코드만.

export const APP_RUN_CAUSES = ['time_budget', 'limit_or_policy', 'model_unavailable', 'model_busy', 'model_error', 'lookup', 'input', 'empty_result', 'other'] as const;
export type AppRunCause = typeof APP_RUN_CAUSES[number];

export const APP_RUN_CAUSE_LABELS: Record<AppRunCause, string> = {
  time_budget: '처리 시간 초과',
  limit_or_policy: '사용 한도·모델 정책 변경',
  model_unavailable: 'AI 서비스 사용 불가(결제·키)',
  model_busy: 'AI 요청 몰림',
  model_error: 'AI 응답 오류',
  lookup: '조회 실패',
  input: '입력·첨부 문제',
  empty_result: '결과가 비어 있음',
  other: '기타',
};

export const isAppRunCause = (v: unknown): v is AppRunCause => typeof v === 'string' && (APP_RUN_CAUSES as readonly string[]).includes(v);

/** 단계를 멈춘 한도·정책 검사의 글(실행기 `guard`) — 까닭을 가르는 데도 쓴다 */
export const APP_LIMIT_OR_POLICY_MESSAGE = '기관 사용량 또는 모델 정책이 변경되어 단계 실행을 중단했습니다.';
/** 마지막 단계가 빈 글을 냈을 때 */
export const APP_EMPTY_RESULT_MESSAGE = '마지막 단계에서 결과가 생성되지 않았습니다.';

/**
 * 오류 → 까닭. 실행기가 오류의 꼴을 먼저 가려 넘긴다(이 파일은 오류 클래스를 모른다):
 * `llm`은 AI 오류의 종류(`llmErrorKind`), `appInput`은 직원이 고칠 수 있는 입력 오류인가, `lookupStep`은 멈춘 단계가 조회·조사 단계인가
 */
export function appRunCause(a: { message: string; llm?: 'unavailable' | 'busy' | 'failed' | null; appInput: boolean; timeBudget: boolean; lookupStep: boolean }): AppRunCause {
  if (a.timeBudget) return 'time_budget';
  if (a.llm === 'unavailable') return 'model_unavailable';
  if (a.llm === 'busy') return 'model_busy';
  if (a.llm === 'failed') return 'model_error';
  if (a.message === APP_LIMIT_OR_POLICY_MESSAGE) return 'limit_or_policy';
  if (a.message === APP_EMPTY_RESULT_MESSAGE) return 'empty_result';
  if (a.appInput) return a.lookupStep ? 'lookup' : 'input';
  return 'other';
}
