// src/lib/rag-eval-tools.ts
// 문서 찾기 평가의 '도구를 쓰는 답'(2026-11-09) — 대화와 같은 도구 루프(`runToolLoop`)를 평가 답에 쓴다(서버).
// 도구는 그 비서의 **공공 데이터(법령·통계·입찰·공시) 도구만** — 대화와 같은 능력 결정(`effectiveCapabilities` — 나만의·부서 비서는 기관 범위로 자름)에서
// public_data만 남긴다. 파일을 만드는 도구(양식 채우기·표 합치기)·첨부 도구·사진은 평가에서 쓰지 않는다(평가가 직원의 파일함에 무엇을 남기면 안 된다).
import { activeCapabilities, effectiveCapabilities, toolsFor } from '@/lib/capabilities';
import type { Capability, TurnContext } from '@/lib/capabilities/types';
import type { CapabilitySettings } from '@/lib/capabilities/settings';
import { getCapabilityScope } from '@/lib/connector-scope';
import { connectorCatalog } from '@/lib/connectors';
import { runToolLoop, type LoopArgs, type LoopProgress, type LoopResult } from '@/lib/assistant/stream';
import { MAX_TOOL_ROUNDS, type SendEvent } from '@/lib/assistant/types';
import type { LlmTool, LlmUsage } from '@/lib/llm/types';

export const RAG_EVAL_NO_TOOLS = '이 비서에 켜진 공공 데이터 도구(법령·통계 등)가 없어 도구를 쓰는 답을 만들 수 없습니다.';
export const RAG_EVAL_TOOLS_UNAVAILABLE = '공공 데이터 도구를 지금 쓸 수 없습니다(연결 키가 없을 수 있습니다).';

export interface EvalToolSetup { tools: LlmTool[]; owners: Map<string, Capability>; ctx: TurnContext }

/** 평가에 쓸 도구 — 대화와 같은 능력 결정에서 공공 데이터만 */
export async function evalToolSetup(
  agent: { id: string; tier: 'personal' | 'department' | 'official'; version: number; capabilities: unknown },
  actor: { organizationId: string; departmentId: string; userId: string },
  deps: { scope?: typeof getCapabilityScope; knownConnectorIds?: string[] } = {},
): Promise<{ ok: true; setup: EvalToolSetup } | { ok: false; message: string }> {
  const settings = effectiveCapabilities(agent.capabilities, {
    tier: agent.tier,
    scope: agent.tier === 'official' ? { publicDataConnectors: new Set() } : await (deps.scope ?? getCapabilityScope)(actor.departmentId),
    knownConnectorIds: deps.knownConnectorIds ?? connectorCatalog().map((c) => c.id),
  });
  if (!settings.public_data?.connectors?.length) return { ok: false, message: RAG_EVAL_NO_TOOLS };
  const only: CapabilitySettings = { public_data: settings.public_data };
  const ctx: TurnContext = {
    organizationId: actor.organizationId, departmentId: actor.departmentId, userId: actor.userId, agentId: agent.id, agentVersion: agent.version,
    capabilities: only, message: '', conversationId: '', attachments: [], preflight: {}, skipDocuments: false,
  };
  const { tools, owners } = toolsFor(activeCapabilities(only), ctx);
  if (!tools.length) return { ok: false, message: RAG_EVAL_TOOLS_UNAVAILABLE };
  return { ok: true, setup: { tools, owners, ctx } };
}

/**
 * 평가 답 하나를 도구 루프로 — 부른 도구 이름은 `tool_start`로 모은다. 도중에 실패해도 그때까지 쓴 토큰은 기록하고(과금 규약) 다시 던진다
 * (성공이면 사용량은 돌려주고 실행기가 기록한다)
 */
export function evalAnswerWithTools(
  setup: EvalToolSetup,
  logUsage: (usage: LlmUsage) => Promise<void>,
  loop: (args: LoopArgs, send: SendEvent) => Promise<LoopResult> = runToolLoop,
) {
  return async (input: { model: string; system: string; question: string }) => {
    const toolsUsed: string[] = [];
    const progress: LoopProgress = { usage: { model: input.model, input_tokens: 0, output_tokens: 0 }, capabilityUsage: [] };
    const spent = (u: LlmUsage) => u.input_tokens > 0 || u.output_tokens > 0;
    try {
      const result = await loop({
        modelId: input.model, systemPrompt: input.system, messages: [{ role: 'user', content: input.question }],
        tools: setup.tools, owners: setup.owners, ctx: { ...setup.ctx, message: input.question }, maxRounds: MAX_TOOL_ROUNDS, progress,
      }, (event) => { if (event.event === 'tool_start') toolsUsed.push(event.data.name); });
      return { text: result.text, usage: [result.usage, ...result.capabilityUsage].filter(spent), shownValues: result.shownValues, toolsUsed };
    } catch (error) {
      for (const usage of [progress.usage, ...progress.capabilityUsage].filter(spent)) await logUsage(usage).catch(() => {});
      throw error;
    }
  };
}
