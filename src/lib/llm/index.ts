// src/lib/llm/index.ts
import { getModel } from '@/lib/models';
import { anthropicAdapter } from './anthropic';
import type { LlmAdapter, LlmRequest } from './types';

export * from './types';

/**
 * 모델 호출의 유일한 입구.
 *
 * 모델 레지스트리(models.ts)의 provider로 어댑터를 고른다. 지금은 Anthropic
 * 하나다. 기관 내부 모델을 붙일 때 레지스트리 항목과 어댑터만 더하면 된다.
 */
let testAdapter: LlmAdapter | null = null;

/** 시험에서 실제 API 대신 가짜 어댑터를 끼운다. 운영 코드에서 부르지 않는다. */
export function setLlmAdapterForTests(adapter: LlmAdapter | null): void {
  testAdapter = adapter;
}

function adapterFor(modelId: string): LlmAdapter {
  if (testAdapter) return testAdapter;
  const provider = getModel(modelId).provider;
  switch (provider) {
    case 'anthropic':
      return anthropicAdapter;
    default:
      throw new Error(`아직 연결하지 않은 AI 업체입니다: ${provider}`);
  }
}

export function streamChat(req: LlmRequest) {
  return adapterFor(req.model).stream(req);
}

export function complete(req: LlmRequest) {
  return adapterFor(req.model).complete(req);
}
