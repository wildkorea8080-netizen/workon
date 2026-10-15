// src/lib/assistant/stream.ts
import { streamChat, complete } from '@/lib/llm';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { toolsFor } from '@/lib/capabilities';
import type { LlmContentBlock, LlmMessage, LlmTool, LlmUsage } from '@/lib/llm/types';
import type { Capability, TurnContext, ToolOutcome, GeneratedFileRef } from '@/lib/capabilities/types';
import type { ToolSource } from '@/lib/connectors';
import { MAX_OUTPUT_TOKENS, MAX_TOOL_ROUNDS, type PreparedTurn, type SendEvent } from './types';
import { dedupeLinks, buildMessageRows, saveMessages, mergeUsageByModel, buildUsageDetails, writeUsageLog } from './persist';

/**
 * 호출한 쪽이 소유하는 누적 사용량. 루프가 도중에 던져도 이미 쓴 토큰이
 * 남도록 루프가 제자리에서 갱신한다 — 쓴 만큼 기록되지 않으면 조용한 과금 누락이다.
 */
export interface LoopProgress {
  usage: LlmUsage;
  capabilityUsage: LlmUsage[];
}

export interface LoopArgs {
  modelId: string;
  systemPrompt: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  /** 도구 이름 → 맡은 능력 (capabilities/index.ts의 toolsFor) */
  owners: Map<string, Capability>;
  ctx: TurnContext;
  maxRounds: number;
  progress?: LoopProgress;
}

export interface LoopResult {
  text: string;
  /** 대화 모델의 사용량. 모델은 실제로 부른 모델이다 */
  usage: LlmUsage;
  /** 능력 안에서 쓴 AI 사용량 */
  capabilityUsage: LlmUsage[];
  links: ToolSource[];
  files: GeneratedFileRef[];
}

export const TOOL_LIMIT_NOTICE =
  '[중요] 도구 호출 한도에 도달해 더 이상 도구를 사용할 수 없습니다. 앞으로 무엇을 하겠다는 예고는 하지 마세요. ' +
  '지금까지 확보한 자료만으로 답변을 완성하되, 자료가 부족하면 무엇이 부족한지와 사용자가 무엇을 다시 물으면 되는지를 알려주세요.';

export const TRUNCATED_TOOL_NOTICE =
  '작성할 내용이 길어 한 번에 파일로 만들지 못했습니다. 항목 분량을 줄이거나 나눠서 만들어 달라고 말씀해 주세요. ' +
  '대화에 쓴 초안이 있으면 그 글을 복사해 쓸 수 있습니다.';

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
  const usage: LlmUsage = args.progress?.usage ?? { model: args.modelId, input_tokens: 0, output_tokens: 0 };
  usage.model = args.modelId;
  const capabilityUsage: LlmUsage[] = args.progress?.capabilityUsage ?? [];
  const links: ToolSource[] = [];
  const files: GeneratedFileRef[] = [];
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

    if (stopReason === 'max_tokens' && calls.length > 0) {
      // 출력 상한에 걸려 마지막 tool_use 입력이 미완성이다(어댑터는 깨진 JSON을 {}로 준다).
      // 실행하면 빈 입력으로 도구가 돌므로 부르지 않고, 사용자가 다음 행동을 알 수 있게
      // 안내를 글에 남긴다 — delta로 보내므로 화면과 저장에 모두 남는다.
      console.warn('[assistant] 출력 상한으로 도구 호출이 잘림 — 실행하지 않음', calls.map((c) => c.name));
      const notice = text ? `\n\n${TRUNCATED_TOOL_NOTICE}` : TRUNCATED_TOOL_NOTICE;
      text += notice;
      send({ event: 'delta', data: { text: notice } });
      break;
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
      const callFiles = outcome.files ?? [];
      links.push(...callLinks);
      files.push(...callFiles);
      if (outcome.usage) capabilityUsage.push(...outcome.usage);
      send({ event: 'tool_end', data: { name: call.name, ok: outcome.ok, sources: callLinks, files: callFiles } });
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

  return { text, usage, capabilityUsage, links: dedupeLinks(links), files };
}

/** 이 턴의 사용량을 모델별로 한 행씩 기록한다. 토큰이 없으면 남기지 않는다 */
async function logChatUsage(turn: PreparedTurn, usages: LlmUsage[], extra: Record<string, unknown>): Promise<void> {
  for (const usage of mergeUsageByModel(usages)) {
    if (usage.input_tokens + usage.output_tokens <= 0) continue;
    await writeUsageLog({
      departmentId: turn.ctx.departmentId,
      userId: turn.ctx.userId,
      action: 'chat_message',
      resourceType: 'conversation',
      resourceId: turn.conversationId,
      details: buildUsageDetails(usage, {
        agent_id: turn.ctx.agentId,
        agent_version: turn.ctx.agentVersion,
        chunks_retrieved: turn.chunks.length,
        model_substituted: turn.modelSubstituted,
        ...extra,
      }),
    });
  }
}

/**
 * 한 턴을 흘려보낸다. 시작 뒤의 실패는 SSE error로 알린다.
 *
 * 순서: meta → 도구 루프(delta·tool_*) → 메시지 저장 → 사용 기록 → 제목 → done
 */
export async function streamTurn(turn: PreparedTurn, rawSend: SendEvent): Promise<void> {
  // 보내기 실패(연결 끊김)가 저장·사용 기록을 건너뛰게 하면 안 된다. 답변을
  // 받지 못한 사용자도 새로고침하면 대화를 볼 수 있어야 하고, 쓴 토큰은 청구된다.
  // 라우트도 enqueue 실패를 삼키지만 실행기가 그 약속에 기대지 않는다.
  const send: SendEvent = (event) => {
    try {
      rawSend(event);
    } catch {
      // 클라이언트가 떠났다
    }
  };

  // 대화 id와 출처를 먼저 보내 화면이 바로 반영하게 한다
  send({ event: 'meta', data: { conversation_id: turn.conversationId, chunks: turn.chunks } });

  const progress: LoopProgress = {
    usage: { model: turn.modelId, input_tokens: 0, output_tokens: 0 },
    capabilityUsage: [],
  };
  let result: LoopResult;
  try {
    result = await runToolLoop(
      {
        modelId: turn.modelId,
        systemPrompt: turn.systemPrompt,
        messages: turn.messages,
        tools: turn.tools,
        owners: toolsFor(turn.capabilities, turn.ctx).owners,
        ctx: turn.ctx,
        maxRounds: MAX_TOOL_ROUNDS,
        progress,
      },
      send
    );
  } catch (error) {
    console.error('[assistant] streaming error:', error);
    // 이미 끝난 라운드와 능력이 쓴 토큰은 청구 대상이다. 던졌다고 지우면 기록이 빠진다.
    await logChatUsage(turn, [progress.usage, ...progress.capabilityUsage], { aborted: true });
    send({ event: 'error', data: { message: error instanceof Error ? error.message : '응답 생성 중 오류가 발생했습니다.' } });
    return;
  }

  const saveError = await saveMessages(
    buildMessageRows({
      conversationId: turn.conversationId,
      userId: turn.ctx.userId,
      userContent: turn.storedUserContent,
      assistantText: result.text,
      chunks: turn.chunks,
      links: result.links,
      files: result.files,
      agentVersion: turn.ctx.agentVersion,
    })
  );
  if (saveError) {
    // 답변은 이미 흘러갔으므로 요청을 실패시킬 수 없다. 저장 실패는 알린다 —
    // 모르면 새로고침 뒤 내용이 사라진 이유를 알 수 없다.
    send({ event: 'error', data: { message: '답변은 생성됐지만 대화 저장에 실패했습니다. 필요하면 내용을 복사해 두세요.' } });
  }

  // 모델이 다르면 단가가 다르므로 모델별로 한 행씩
  await logChatUsage(turn, [result.usage, ...result.capabilityUsage], {});

  // 새 대화면 제목. 이 턴의 모델로 부른다 — 기본 모델이 기관 허용 목록에
  // 없을 수 있다. 쓴 토큰도 기록한다(예전에는 빠져 있었다).
  let title: string | null = null;
  if (turn.isNewConversation) {
    try {
      const completion = await complete({
        model: turn.modelId,
        maxTokens: 40,
        messages: [
          {
            role: 'user',
            content: `다음 질문을 20자 이내 한국어 제목으로 요약해줘. 제목만 출력하고 다른 설명은 하지 마: "${turn.ctx.message}"`,
          },
        ],
      });
      await writeUsageLog({
        departmentId: turn.ctx.departmentId,
        userId: turn.ctx.userId,
        action: 'conversation_title',
        resourceType: 'conversation',
        resourceId: turn.conversationId,
        details: buildUsageDetails(completion.usage, { agent_id: turn.ctx.agentId }),
      });
      const autoTitle = completion.text.trim().replace(/^["']|["']$/g, '').slice(0, 30);
      if (autoTitle) {
        await supabaseAdmin.from('conversations').update({ title: autoTitle }).eq('id', turn.conversationId);
        title = autoTitle;
      }
    } catch (error) {
      // 제목 생성 실패는 대화에 영향이 없다. 다만 이유는 남긴다 — 모르면 제목이
      // 계속 '대화 with ...'로 남는 원인을 찾을 수 없다.
      console.warn('[assistant] 제목 생성 실패', error);
    }
  }

  send({ event: 'done', data: { usage: result.usage, title } });
}
