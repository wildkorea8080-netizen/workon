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
  /** 입력 컨텍스트 상한(토큰). 긴 문서를 다룰 때 담당자가 봐야 하는 값. */
  contextWindow: number;
  /** 관리자가 고를 때 판단 근거가 되는 한 줄 설명 */
  note: string;
}

export const MODELS: Record<string, ModelDefinition> = {
  'claude-sonnet-4-6': {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    label: 'Claude Sonnet 4.6',
    inputPerMTok: 3,
    outputPerMTok: 15,
    enabled: true,
    contextWindow: 1_000_000,
    note: '기본 모델. 일반 문서 작성·요약에 충분합니다.',
  },
  'claude-opus-5': {
    id: 'claude-opus-5',
    provider: 'anthropic',
    label: 'Claude Opus 5',
    inputPerMTok: 5,
    outputPerMTok: 25,
    enabled: true,
    contextWindow: 1_000_000,
    note: '가장 정확합니다. 법령 해석·복잡한 보고서처럼 틀리면 곤란한 일에 씁니다.',
  },
  'claude-sonnet-5': {
    id: 'claude-sonnet-5',
    provider: 'anthropic',
    label: 'Claude Sonnet 5',
    inputPerMTok: 3,
    outputPerMTok: 15,
    enabled: true,
    contextWindow: 1_000_000,
    note: '균형형. Sonnet 4.6과 같은 단가로 더 나은 품질을 냅니다.',
  },
  'claude-haiku-4-5': {
    id: 'claude-haiku-4-5',
    provider: 'anthropic',
    label: 'Claude Haiku 4.5',
    inputPerMTok: 1,
    outputPerMTok: 5,
    enabled: true,
    contextWindow: 200_000,
    note: '가장 저렴합니다. 음슴체 변환·개조식 정리처럼 단순 변환에 적합합니다.',
  },
  // 모델 추가 시: 단가는 반드시 공식 가격표를 확인해 넣을 것.
  // 다른 프로바이더를 붙이려면 src/lib/llm/ 어댑터 계층이 먼저 필요하다.
};

/**
 * 새 대화가 기본으로 쓰는 모델.
 *
 * 바꾸면 허용 목록을 정하지 않은(allowed_models IS NULL) 모든 기관의 동작과
 * 비용이 함께 바뀐다. 정책 계층이 있으니 관리자가 골라 쓰게 두고, 이 값은
 * 신중하게 옮긴다.
 */
export const DEFAULT_MODEL_ID = 'claude-sonnet-4-6';

/**
 * 모델 정보가 없는 과거 로그를 추정할 때 쓰는 단가 기준.
 *
 * DEFAULT_MODEL_ID와 분리한 이유가 중요하다. 둘을 같이 쓰면 기본 모델을
 * 바꾸는 순간 **과거 정산이 소급해서 달라진다.** 2026-08 이전 로그에는
 * details.model이 없고, 그 시기에 실제로 돌던 모델은 Sonnet 4.6이다.
 * 그 사실은 앞으로 무엇을 기본으로 삼든 변하지 않는다.
 */
export const LEGACY_PRICING_MODEL_ID = 'claude-sonnet-4-6';

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
        // model이 없는 옛 로그는 그 시기에 실제로 돌던 모델 단가로 추정한다.
        // 기본 모델을 따라가게 두면 과거 정산이 소급해서 달라진다.
        d.model ?? LEGACY_PRICING_MODEL_ID
      )
    );
  }, 0);
  return parseFloat(total.toFixed(4));
}
