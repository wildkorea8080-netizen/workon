// src/lib/assistant/stream.ts
import { streamChat } from '@/lib/llm';
import type { LlmContentBlock, LlmMessage, LlmTool, LlmUsage } from '@/lib/llm/types';
import type { Capability, TurnContext, ToolOutcome } from '@/lib/capabilities/types';
import type { ToolSource } from '@/lib/connectors';
import { MAX_OUTPUT_TOKENS, type SendEvent } from './types';
import { dedupeLinks } from './persist';

export interface LoopArgs {
  modelId: string;
  systemPrompt: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  /** 도구 이름 → 맡은 능력 (capabilities/index.ts의 toolsFor) */
  owners: Map<string, Capability>;
  ctx: TurnContext;
  maxRounds: number;
}

export interface LoopResult {
  text: string;
  /** 대화 모델의 사용량. 모델은 실제로 부른 모델이다 */
  usage: LlmUsage;
  /** 능력 안에서 쓴 AI 사용량 */
  capabilityUsage: LlmUsage[];
  links: ToolSource[];
}

export const TOOL_LIMIT_NOTICE =
  '[중요] 도구 호출 한도에 도달해 더 이상 도구를 사용할 수 없습니다. 앞으로 무엇을 하겠다는 예고는 하지 마세요. ' +
  '지금까지 확보한 자료만으로 답변을 완성하되, 자료가 부족하면 무엇이 부족한지와 사용자가 무엇을 다시 물으면 되는지를 알려주세요.';

async function executeCall(
  owners: Map<string, Capability>,
  call: { name: string; input: Record<string, unknown> },
  ctx: TurnContext
): Promise<ToolOutcome> {
  // 모델은 꺼내 준 도구만 부를 수 있지만 실행 직전에 한 번 더 확인한다
  const owner = owners.get(call.name);
  if (!owner?.execute) return { ok: false, text: `허용되지 않은 도구입니다: ${call.name}` };
  try {
    return await owner.execute(call.name, call.input, ctx);
  } catch (error) {
    // 한 능력이 실패해도 대화는 계속된다(설계 7.5). 이유는 모델과 화면에 함께 간다.
    console.error(`[assistant] ${call.name} 실행 오류:`, error);
    return {
      ok: false,
      text: `도구 실행 중 오류가 발생했습니다: ${error instanceof Error ? error.message : '알 수 없는 오류'}`,
    };
  }
}

export async function runToolLoop(args: LoopArgs, send: SendEvent): Promise<LoopResult> {
  const messages: LlmMessage[] = [...args.messages];
  const usage: LlmUsage = { model: args.modelId, input_tokens: 0, output_tokens: 0 };
  const capabilityUsage: LlmUsage[] = [];
  const links: ToolSource[] = [];
  const tools = args.tools.length > 0 ? args.tools : undefined;
  let text = '';

  for (let round = 0; round < args.maxRounds; round++) {
    const calls: { id: string; name: string; input: Record<string, unknown> }[] = [];
    let roundText = '';
    let stopReason: string | null = null;

    for await (const event of streamChat({
      model: args.modelId,
      system: args.systemPrompt,
      messages,
      maxTokens: MAX_OUTPUT_TOKENS,
      tools,
    })) {
      if (event.type === 'text') {
        roundText += event.text;
        text += event.text;
        send({ event: 'delta', data: { text: event.text } });
      } else if (event.type === 'tool_use') {
        calls.push({ id: event.id, name: event.name, input: event.input });
      } else {
        usage.input_tokens += event.usage.input_tokens;
        usage.output_tokens += event.usage.output_tokens;
        stopReason = event.stopReason;
      }
    }

    if (stopReason !== 'tool_use' || calls.length === 0) break;

    // 모델이 만든 턴을 그대로 이력에 더한다 (글 + tool_use 블록)
    const assistantBlocks: LlmContentBlock[] = [];
    if (roundText) assistantBlocks.push({ type: 'text', text: roundText });
    for (const call of calls) assistantBlocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
    messages.push({ role: 'assistant', content: assistantBlocks });

    const resultBlocks: LlmContentBlock[] = [];
    for (const call of calls) {
      send({ event: 'tool_start', data: { name: call.name, input: call.input } });
      const outcome = await executeCall(args.owners, call, args.ctx);
      const callLinks = outcome.sources?.links ?? [];
      links.push(...callLinks);
      if (outcome.usage) capabilityUsage.push(...outcome.usage);
      send({ event: 'tool_end', data: { name: call.name, ok: outcome.ok, sources: callLinks } });
      resultBlocks.push({ type: 'tool_result', tool_use_id: call.id, content: outcome.text, is_error: !outcome.ok });
    }
    messages.push({ role: 'user', content: resultBlocks });

    if (round === args.maxRounds - 1) {
      // 상한에 걸렸다. 그냥 끝내면 방금 받은 도구 결과를 모델에 돌려주지 못해
      // 사용자는 "찾아볼게요" 같은 도입부만 받는다. 도구 정의는 유지한 채
      // tool_choice='none'으로 한 번 더 불러 답을 마무리시킨다.
      console.warn('[assistant] 도구 라운드 상한 도달 — tool_choice=none으로 마무리');
      send({ event: 'tool_limit', data: { rounds: args.maxRounds } });
      for await (const event of streamChat({
        model: args.modelId,
        system: `${args.systemPrompt}\n\n${TOOL_LIMIT_NOTICE}`,
        messages,
        maxTokens: MAX_OUTPUT_TOKENS,
        tools,
        toolChoice: 'none',
      })) {
        if (event.type === 'text') {
          text += event.text;
          send({ event: 'delta', data: { text: event.text } });
        } else if (event.type === 'done') {
          usage.input_tokens += event.usage.input_tokens;
          usage.output_tokens += event.usage.output_tokens;
        }
      }
    }
  }

  return { text, usage, capabilityUsage, links: dedupeLinks(links) };
}
