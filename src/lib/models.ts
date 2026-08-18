/**
 * LLM 모델 레지스트리 — 모델 추가/교체 시 이 파일만 고치면 됩니다.
 *
 * 배경: 단가가 6개 라우트에 `(tokens/1M)*3 + (tokens/1M)*15` 형태로 하드코딩돼
 * 있었습니다. 모델이 하나일 때는 문제가 없지만, 두 번째 모델을 붙이는 순간
 * 모든 집계가 틀어집니다. 단가·환율은 전부 여기로 모읍니다.
 *
 * 모델을 추가하려면 MODELS에 항목 하나만 넣으면 됩니다.
 */

import { USD_KRW_RATE } from '@/lib/config';

export type ModelProvider = 'anthropic' | 'openai' | 'google' | 'upstage';

export interface ModelDefinition {
  id: string;
  provider: ModelProvider;
  label: string;
  /** 100만 토큰당 USD */
  inputPerMTok: number;
  outputPerMTok: number;
  /** false면 UI 노출 안 함 (단가는 과거 로그 정산용으로 남겨둠) */
  enabled: boolean;
}

export const MODELS: Record<string, ModelDefinition> = {
  'claude-sonnet-4-6': {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    label: 'Claude Sonnet 4.6',
    inputPerMTok: 3,
    outputPerMTok: 15,
    enabled: true,
  },
  // 모델 추가 예시 — 단가는 반드시 각 사 공식 가격표를 확인해 넣을 것.
  // 'gpt-5.5': { id: 'gpt-5.5', provider: 'openai', label: 'GPT-5.5',
  //              inputPerMTok: ?, outputPerMTok: ?, enabled: true },
};

/** 현재 서비스 기본 모델 */
export const DEFAULT_MODEL_ID = 'claude-sonnet-4-6';

export function getModel(modelId?: string | null): ModelDefinition {
  return (modelId && MODELS[modelId]) || MODELS[DEFAULT_MODEL_ID];
}

export function enabledModels(): ModelDefinition[] {
  return Object.values(MODELS).filter((m) => m.enabled);
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}

/** 토큰 사용량 → USD. modelId가 없으면 기본 모델 단가로 추정한다. */
export function estimateCostUsd(usage: TokenUsage, modelId?: string | null): number {
  const model = getModel(modelId);
  const cost =
    (usage.input_tokens / 1_000_000) * model.inputPerMTok +
    (usage.output_tokens / 1_000_000) * model.outputPerMTok;
  return parseFloat(cost.toFixed(6));
}

export function usdToKrw(usd: number): number {
  return Math.round(usd * USD_KRW_RATE);
}

export function estimateCostKrw(usage: TokenUsage, modelId?: string | null): number {
  return usdToKrw(estimateCostUsd(usage, modelId));
}

/**
 * usage_logs 행 묶음의 총 USD 비용.
 *
 * details.cost_usd가 있으면 그 값을 쓰고(기록 시점의 정확한 단가),
 * 없으면 토큰 × 기본 모델 단가로 추정합니다.
 * 2026-08 이전 로그에는 model/cost 필드가 없으므로 이 폴백이 필요합니다.
 */
export function sumCostUsd(logs: { details?: any }[]): number {
  const total = logs.reduce((sum, log) => {
    const d = log.details ?? {};
    if (typeof d.cost_usd === 'number') return sum + d.cost_usd;
    return (
      sum +
      estimateCostUsd(
        { input_tokens: d.input_tokens ?? 0, output_tokens: d.output_tokens ?? 0 },
        d.model
      )
    );
  }, 0);
  return parseFloat(total.toFixed(4));
}
