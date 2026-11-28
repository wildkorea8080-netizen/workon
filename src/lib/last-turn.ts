// src/lib/last-turn.ts
// 대화의 마지막 턴 지우기(2026-11-28) — '답변 다시 받기'·'질문 고쳐 묻기'가 쓴다.
// 같은 질문을 새로 적어 다시 물으면 이력에 같은 질문이 두 번 남고 모델도 앞 답을 본 채 답한다 — 그래서 마지막 질문·답 두 행을 먼저 지운다.
// 대화 주인만, 마지막 답이 화면이 보낸 그 답일 때만(그 사이 다른 턴이 생겼으면 409). 입력형 앱 실행 결과는 지우지 않는다(예약·보내기·일괄 실행이 그 답을 가리킴 — 앱은 '다시 실행').
// 사용 기록(usage_logs)은 쌓기만 하므로 그대로 남고, 비서가 만든 파일·대화에 붙인 첨부도 대화에 그대로 남는다.

export type TurnRow = { id: string; role: string; source_references: unknown };

export type LastTurnVerdict =
  | { ok: true; ids: [string, string] }
  | { ok: false; status: number; message: string };

export const LAST_TURN_MESSAGES = {
  notLast: '마지막 답변만 다시 받을 수 있습니다. 대화를 새로 열어 확인해 주세요.',
  app: '입력형 앱의 실행 결과는 지우지 않습니다 — 앱 화면에서 다시 실행해 주세요.',
} as const;

const refs = (row: TurnRow): Record<string, unknown> =>
  row.source_references && typeof row.source_references === 'object' && !Array.isArray(row.source_references) ? (row.source_references as Record<string, unknown>) : {};

/**
 * 최신순으로 읽은 끝의 두 행(답 먼저 — 같은 시각이면 역할 오름차순)이 [이 답, 그 질문]인가
 */
export function decideLastTurn(latest: TurnRow[], messageId: string): LastTurnVerdict {
  const [answer, question] = latest;
  if (!answer || !question || answer.role !== 'assistant' || question.role !== 'user' || answer.id !== messageId) {
    return { ok: false, status: 409, message: LAST_TURN_MESSAGES.notLast };
  }
  const isApp = (r: Record<string, unknown>) => r.app_steps !== undefined || r.app_inputs !== undefined || r.app_draft !== undefined || r.app_schedule !== undefined;
  if (isApp(refs(answer)) || isApp(refs(question))) {
    return { ok: false, status: 400, message: LAST_TURN_MESSAGES.app };
  }
  return { ok: true, ids: [answer.id, question.id] };
}
