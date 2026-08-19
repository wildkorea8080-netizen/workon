import { describe, it, expect } from 'vitest';
import { resolveModel, POLICY_FALLBACK_MODEL_ID } from '@/lib/model-policy';
import {
  MODELS,
  DEFAULT_MODEL_ID,
  LEGACY_PRICING_MODEL_ID,
  estimateCostUsd,
  sumCostUsd,
  enabledModels,
} from '@/lib/models';

/**
 * 허용 모델 정책과 단가.
 *
 * 여기서 조용히 틀리면 두 가지가 함께 무너진다 — 기관이 허용하지 않은
 * 모델로 대화가 나가거나, 과거 정산 금액이 소급해서 바뀐다.
 */

describe('resolveModel — 정책 밖 요청은 대체한다', () => {
  const allowed = ['claude-sonnet-4-6'];

  it('요청이 없으면 허용 목록의 첫 모델을 쓴다', () => {
    expect(resolveModel(null, allowed)).toEqual({
      modelId: 'claude-sonnet-4-6',
      substituted: false,
    });
  });

  it('허용된 모델은 그대로 쓴다', () => {
    expect(resolveModel('claude-sonnet-4-6', allowed).substituted).toBe(false);
  });

  it('허용되지 않은 모델은 대체하고 그 사실을 알린다', () => {
    const result = resolveModel('claude-opus-5', allowed);
    expect(result.modelId).toBe('claude-sonnet-4-6');
    // substituted를 놓치면 정책 위반이 로그에도 안 남는다
    expect(result.substituted).toBe(true);
  });

  it('허용 목록이 비어도 기본 모델로 열어 준다', () => {
    // 빈 목록을 그대로 두면 그 기관은 아무 대화도 못 하게 잠긴다
    expect(resolveModel('anything', []).modelId).toBe(POLICY_FALLBACK_MODEL_ID);
  });
});

describe('단가 — 과거 정산이 소급해서 바뀌지 않아야 한다', () => {
  it('model이 없는 옛 로그는 LEGACY 기준 단가로 추정한다', () => {
    // 2026-08 이전 로그에는 details.model이 없다. 그 시기에 실제로 돌던
    // 모델은 Sonnet 4.6이고, 기본 모델을 무엇으로 바꾸든 그 사실은 안 변한다.
    const legacy = MODELS[LEGACY_PRICING_MODEL_ID];
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    const expected = legacy.inputPerMTok + legacy.outputPerMTok;

    expect(sumCostUsd([{ details: usage }])).toBeCloseTo(expected, 4);
  });

  it('LEGACY 기준은 Sonnet 4.6에 고정돼 있다', () => {
    // 이 값을 DEFAULT_MODEL_ID를 따라가게 바꾸면 과거 정산이 흔들린다.
    expect(LEGACY_PRICING_MODEL_ID).toBe('claude-sonnet-4-6');
  });

  it('cost_usd가 기록된 로그는 그 값을 그대로 쓴다', () => {
    // 기록 시점 단가로 확정해 두는 이유 — 나중에 단가가 바뀌어도 흔들리면 안 된다
    const logs = [{ details: { cost_usd: 0.1234, input_tokens: 999, output_tokens: 999 } }];
    expect(sumCostUsd(logs)).toBeCloseTo(0.1234, 4);
  });

  it('모든 등록 모델에 단가와 컨텍스트가 있다', () => {
    for (const model of enabledModels()) {
      expect(model.inputPerMTok, `${model.id} 입력 단가`).toBeGreaterThan(0);
      expect(model.outputPerMTok, `${model.id} 출력 단가`).toBeGreaterThan(0);
      expect(model.contextWindow, `${model.id} 컨텍스트`).toBeGreaterThan(0);
    }
  });

  it('모델 id에 날짜 접미사가 붙어 있지 않다', () => {
    // claude-sonnet-4-6-20251114 같은 형태는 존재하지 않는다.
    // 붙이면 API가 404를 준다.
    for (const id of Object.keys(MODELS)) {
      expect(id, `${id}에 날짜 접미사`).not.toMatch(/-\d{8}$/);
    }
  });

  it('기본 모델이 레지스트리에 실제로 있다', () => {
    expect(MODELS[DEFAULT_MODEL_ID]).toBeDefined();
    expect(MODELS[LEGACY_PRICING_MODEL_ID]).toBeDefined();
  });
});

describe('estimateCostUsd', () => {
  it('모델마다 다른 금액을 낸다', () => {
    const usage = { input_tokens: 10_000, output_tokens: 2_000 };
    const haiku = estimateCostUsd(usage, 'claude-haiku-4-5');
    const opus = estimateCostUsd(usage, 'claude-opus-5');

    // 단가가 하나로 하드코딩돼 있으면 이 둘이 같아진다 — 예전에 실제로 그랬다
    expect(haiku).toBeLessThan(opus);
  });

  it('모르는 모델 id는 기본 모델 단가로 떨어진다', () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 0 };
    expect(estimateCostUsd(usage, 'nonexistent-model')).toBeCloseTo(
      MODELS[DEFAULT_MODEL_ID].inputPerMTok,
      4
    );
  });
});
