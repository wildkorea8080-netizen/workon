/**
 * AI 호출 실패 — 원문은 서버 기록에, 직원에게는 할 일을 알려 주는 한국어 안내만.
 *
 * 예전에는 Anthropic 원문("credit balance is too low…")이 직원 화면에 그대로 떴다.
 * 결제 상태 같은 내부 사정이 드러나고, 직원은 무엇을 해야 할지 알 수 없다.
 */

export const LLM_MESSAGES = {
  /** 결제·키 문제 — 직원이 기다려도 풀리지 않는다 */
  unavailable: '지금은 AI 서비스를 쓸 수 없습니다. 기관 관리자에게 문의해 주세요.',
  /** 요청 몰림 — 잠시 뒤 풀린다 */
  busy: 'AI 서비스에 요청이 몰려 있습니다. 잠시 뒤 다시 시도해 주세요.',
  failed: 'AI 응답을 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
} as const;

export class LlmApiError extends Error {
  constructor(
    public readonly status: number | null,
    public readonly detail: string,
    public readonly type?: string
  ) {
    super(`Claude API 오류: ${status ?? type ?? ''} - ${detail}`);
    this.name = 'LlmApiError';
  }
}

export type LlmErrorKind = keyof typeof LLM_MESSAGES;

export function llmErrorKind(e: LlmApiError): LlmErrorKind {
  const text = `${e.type ?? ''} ${e.detail}`;
  if (e.status === 401 || e.status === 403 || e.type === 'missing_key' || /credit balance|billing|api[ -]?key/i.test(text)) {
    return 'unavailable';
  }
  if (e.status === 429 || e.status === 529 || e.status === 503 || /overloaded|rate.?limit/i.test(text)) return 'busy';
  return 'failed';
}

/** AI 오류면 직원에게 보일 안내, 아니면 null(부르는 쪽이 자기 문구를 쓴다) */
export function friendlyLlmMessage(e: unknown): string | null {
  return e instanceof LlmApiError ? LLM_MESSAGES[llmErrorKind(e)] : null;
}
