import { renderAppInput, type AppDefinition } from './definition';
import type { AppStepRecord } from './pipeline';
import type { AppResumeSource } from './resume-client';
import { APP_TIME_BUDGET_CODE } from './stream';

/**
 * 손 실행의 자동 이어 실행(2026-11-08) — 실행 화면에서 처리 시간 예산(3분)에 멈춘 실행을 끝난 단계부터 곧바로 이어 간다.
 * 예약의 자동 이어 실행(0074)과 같은 규칙: 입력만 쓰는 실행만(서버가 그때만 재개용 입력을 저장한다), 한 번 누름에 두 번까지,
 * 이어 가도 진행(끝난 단계·줄)이 늘지 않으면 멈춘다(같은 자리에서 계속 멈추는 실행이 사용량만 쓰지 않게).
 * 실제로 이어 갈 수 있는지는 대화 실행기가 `resume_message_id`를 다시 본다 — 여기는 화면의 판단일 뿐이다.
 */
export const APP_AUTO_RESUME_MAX = 2;

/** 진행의 크기 — 끝난 단계가 먼저, 같으면 반복이 끝낸 줄 수(줄은 8개까지라 단계 하나보다 작다) */
export function appResumeProgress(records: AppStepRecord[]): number {
  return records.reduce((total, record) => total
    + (record.status === 'completed' ? 1000 : 0)
    + (record.status === 'failed' && Array.isArray(record.partial) ? record.partial.length : 0), 0);
}

export type AutoResumeInput = {
  /** 스트림 `error` 사건의 코드 */
  code?: string;
  /** 멈춘 실행을 다시 읽은 기록(이어 갈 수 없으면 null) */
  source: AppResumeSource | null;
  definition: AppDefinition;
  /** 지금 화면의 입력 — 원래 입력과 같아야 한다 */
  values: Record<string, string>;
  /** 파일을 붙였거나 문서를 골랐다 — 근거가 바뀌어 이어 갈 수 없다 */
  filesAdded: boolean;
  /** 시험 판 실행 — 이어 실행은 지금 판에만 있다 */
  draft: boolean;
  /** 이번 누름에서 이미 자동으로 이어 간 횟수 */
  attempt: number;
  /** 직전에 이어 간 실행의 진행(첫 실행이면 -1) */
  previousProgress: number;
};

export type AutoResumeDecision = { resume: true; messageId: string; attempt: number; progress: number } | { resume: false };

export function autoResumeDecision(input: AutoResumeInput): AutoResumeDecision {
  if (input.code !== APP_TIME_BUDGET_CODE || !input.source || input.draft || input.filesAdded) return { resume: false };
  if (input.attempt >= APP_AUTO_RESUME_MAX) return { resume: false };
  const now = renderAppInput(input.definition, input.values);
  const before = renderAppInput(input.definition, input.source.inputs);
  if (!now.ok || !before.ok || now.message !== before.message) return { resume: false };
  const progress = appResumeProgress(input.source.records);
  if (progress <= 0 || progress <= input.previousProgress) return { resume: false };
  return { resume: true, messageId: input.source.id, attempt: input.attempt + 1, progress };
}

/** 자동으로 이어 가는 동안의 안내 */
export function autoResumeStatus(attempt: number): string {
  return `처리 시간이 길어 끝난 단계부터 자동으로 이어 갑니다 (${attempt}/${APP_AUTO_RESUME_MAX})…`;
}
