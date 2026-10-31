import type { LlmUsage } from '@/lib/llm';

/**
 * 과금 규약 — 모델이 토큰을 쓴 뒤 응답 검사(JSON 형식 등)에서 던지면 쓴 토큰을 오류에 실어 보낸다.
 * 호출한 쪽(runs/shared.ts `callModel`)이 그 토큰을 사용 기록에 한 번 남긴다 — 안 남기면 Anthropic에는
 * 청구되고 usage_logs·예산 판정에서는 빠진다. 모델 호출 자체가 실패한 오류(토큰 없음)에는 싣지 않는다.
 */
export function parseSpent<T>(usage: LlmUsage, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error && typeof error === 'object') Object.assign(error, { spentUsage: usage });
    throw error;
  }
}

/** 오류에 실린 쓴 토큰 — 모양이 틀리면 null */
export function spentUsageOf(error: unknown): LlmUsage | null {
  const u = error && typeof error === 'object' ? (error as { spentUsage?: unknown }).spentUsage : null;
  if (!u || typeof u !== 'object') return null;
  const { model, input_tokens, output_tokens } = u as Record<string, unknown>;
  if (typeof model !== 'string' || typeof input_tokens !== 'number' || typeof output_tokens !== 'number') return null;
  return { model, input_tokens, output_tokens };
}
