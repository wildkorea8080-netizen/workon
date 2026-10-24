// src/lib/assistant/stream.ts
import { streamChat, complete } from '@/lib/llm';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { toolsFor } from '@/lib/capabilities';
import type { LlmContentBlock, LlmMessage, LlmTool, LlmUsage } from '@/lib/llm/types';
import type { Capability, TurnContext, ToolOutcome, GeneratedFileRef } from '@/lib/capabilities/types';
import type { ToolSource } from '@/lib/connectors';
import { MAX_OUTPUT_TOKENS, MAX_TOOL_ROUNDS, type PreparedTurn, type SendEvent } from './types';
import { dedupeLinks, buildMessageRows, saveMessages, mergeUsageByModel, buildUsageDetails, writeUsageLog } from './persist';
import { LlmApiError, friendlyLlmMessage, llmErrorKind } from '@/lib/llm/errors';
import { logSystem } from '@/lib/logger';
import { checkNumbers, numbersIn, NUMBER_CHECK_TOOLS } from './number-check';
import { noda, nodaTenant, NodaError, VERIFY_TIMEOUT_MS, type NodaVerifyResult } from '@/lib/noda';

const GENERIC_TURN_ERROR = '응답 생성 중 오류가 발생했습니다. 잠시 뒤 다시 시도해 주세요.';

/** NODA 답변 검증(`/verify`). 테스트가 바꿔 끼운다 — 기본은 `noda.verifyAnswer` */
export type VerifyFn = (input: {
  tenant: string;
  answer: string;
  sources: { doc_id: string; chunk_id: string }[];
}) => Promise<NodaVerifyResult>;

export interface StreamTurnDeps {
  verify?: VerifyFn;
}

const defaultVerify: VerifyFn = (input) => noda.verifyAnswer(input);

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
  /** 이번 턴에 도구가 AI에게 보여 준 숫자 — 숫자 확인이 답변과 대조한다 */
  shownValues: number[];
  /** 첨부 도구(read_attachment·combine_tables)가 한 번이라도 성공했는가. 아니면 숫자 확인을 하지 않는다 */
  attachmentToolSucceeded: boolean;
}

export const TOOL_LIMIT_NOTICE =
  '[중요] 도구 호출 한도에 도달해 더 이상 도구를 사용할 수 없습니다. 앞으로 무엇을 하겠다는 예고는 하지 마세요. ' +
  '지금까지 확보한 자료만으로 답변을 완성하되, 자료가 부족하면 무엇이 부족한지와 사용자가 무엇을 다시 물으면 되는지를 알려주세요.';

/**
 * 도구 결과 뒤에 모델이 글 없이 턴을 끝냈을 때 한 번 보내는 이어 쓰기 요청.
 * 같은 요청을 그대로 다시 보내면 모델은 이미 끝났다고 보고 또 빈 답을 낸다 — 새 사용자 메시지로 요청해야 한다
 * (Anthropic 문서 'Empty responses with end_turn').
 */
export const ANSWER_AFTER_TOOLS_NOTICE =
  '지금까지 도구로 확보한 자료로 처음 질문에 대한 답변을 작성해 주세요. 더 조회하겠다는 예고 없이 답변만 써 주세요.';

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
  const shownValues: number[] = [];
  let attachmentToolSucceeded = false;
  const tools = args.tools.length > 0 ? args.tools : undefined;
  let text = '';
  let toolsRan = false;

  /**
   * 도구 없이 답만 받는 마지막 호출. 요청은 시스템 지시만이 아니라 **도구 결과 뒤 사용자 메시지**로도 보낸다 —
   * 도구 결과 바로 뒤에서 tool_choice=none으로만 부르면 모델이 글 없이 end_turn을 낸다(실측 2026-10-23: Sonnet 4.6,
   * 법령 조회 4회 뒤 8토큰 빈 답 → 사용자 메시지를 붙이자 2,496자 답). 도구 정의는 유지한다 — 빼면 이력의 tool_use
   * 블록 때문에 400이다. 돌려준 글은 화면(delta)과 저장에 그대로 간다.
   */
  const answerWithoutTools = async (userNotice: string, systemExtra?: string): Promise<string> => {
    messages.push({ role: 'user', content: userNotice });
    let answer = '';
    for await (const event of streamChat({
      model: args.modelId,
      system: systemExtra ? `${args.systemPrompt}\n\n${systemExtra}` : args.systemPrompt,
      messages,
      maxTokens: MAX_OUTPUT_TOKENS,
      tools,
      toolChoice: 'none',
    })) {
      if (event.type === 'text') {
        answer += event.text;
        text += event.text;
        send({ event: 'delta', data: { text: event.text } });
      } else if (event.type === 'done') {
        usage.input_tokens += event.usage.input_tokens;
        usage.output_tokens += event.usage.output_tokens;
      }
    }
    return answer;
  };

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

    if (stopReason !== 'tool_use' || calls.length === 0) {
      // 도구 결과를 받고도 글 없이 끝났다 — 사용자는 "찾아볼게요" 같은 도입부만 받는다. 한 번만 이어 쓰기를 요청한다
      if (toolsRan && !roundText.trim()) {
        console.warn('[assistant] 도구 결과 뒤 빈 답 — 이어 쓰기 요청');
        await answerWithoutTools(ANSWER_AFTER_TOOLS_NOTICE);
      }
      break;
    }

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
      // 값을 밝히지 않은 도구(법령·통계 등)는 돌려준 글의 숫자가 곧 보여 준 숫자다.
      // 표 하나가 수만 칸이라 펼쳐 넘기지(push(...)) 않는다 — 인자 수 상한에 걸린다
      for (const v of outcome.shownValues ?? numbersIn(outcome.text)) shownValues.push(v);
      if (outcome.ok && NUMBER_CHECK_TOOLS.has(call.name)) attachmentToolSucceeded = true;
      send({ event: 'tool_end', data: { name: call.name, ok: outcome.ok, sources: callLinks, files: callFiles } });
      resultBlocks.push({ type: 'tool_result', tool_use_id: call.id, content: outcome.text, is_error: !outcome.ok });
    }
    messages.push({ role: 'user', content: resultBlocks });
    toolsRan = true;

    if (round === args.maxRounds - 1) {
      // 상한에 걸렸다. 그냥 끝내면 방금 받은 도구 결과를 모델에 돌려주지 못해
      // 사용자는 "찾아볼게요" 같은 도입부만 받는다. 도구 없이 한 번 더 불러 답을 마무리시킨다.
      console.warn('[assistant] 도구 라운드 상한 도달 — tool_choice=none으로 마무리');
      send({ event: 'tool_limit', data: { rounds: args.maxRounds } });
      await answerWithoutTools(TOOL_LIMIT_NOTICE, TOOL_LIMIT_NOTICE);
    }
  }

  return { text, usage, capabilityUsage, links: dedupeLinks(links), files, shownValues, attachmentToolSucceeded };
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
        // 유사도 하한(0.80)을 다시 정할 근거. 질문 원문은 남기지 않는다(설계 5절)
        doc_dropped: turn.docDropped,
        model_substituted: turn.modelSubstituted,
        ...extra,
      }),
    });
  }
}

/**
 * NODA 답변 검증 — 감사 기록으로만 남긴다(판정 R1: 화면의 '확인되지 않은 숫자'는 로컬 대조 하나로 낸다).
 * 근거(`turn.verifySources`)가 없거나 답이 비었으면 부르지 않는다. 한 번만, `VERIFY_TIMEOUT_MS`까지만 기다린다 —
 * 넘기면 진행 중인 요청은 버리고 검증 없이 저장한다. 실패는 운영 기록에만(답변 글·파일 이름은 남기지 않는다)
 */
async function verifyTurn(turn: PreparedTurn, answer: string, verify: VerifyFn): Promise<NodaVerifyResult | null> {
  if (turn.verifySources.length === 0 || !answer.trim()) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const call = Promise.resolve().then(() =>
      verify({ tenant: nodaTenant(turn.ctx.agentId), answer, sources: turn.verifySources })
    );
    // 시간 제한으로 버린 요청이 뒤늦게 실패해도 처리되지 않은 거부로 남지 않게
    call.catch(() => {});
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new NodaError('NODA 답변 검증이 시간 안에 끝나지 않았습니다.', 'timeout')), VERIFY_TIMEOUT_MS);
    });
    return await Promise.race([call, timeout]);
  } catch (error) {
    await logSystem({
      level: 'warning',
      category: 'api',
      message: 'NODA 답변 검증 실패 — 검증 없이 저장',
      details: {
        agent_id: turn.ctx.agentId,
        code: error instanceof NodaError ? error.code : 'unknown',
        status: error instanceof NodaError ? error.status : null,
      },
      orgId: turn.ctx.organizationId,
    });
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 한 턴을 흘려보낸다. 시작 뒤의 실패는 SSE error로 알린다.
 *
 * 순서: meta → 도구 루프(delta·tool_*) → 숫자 확인·NODA 검증 → 메시지 저장 → 사용 기록 → 제목 → done
 */
export async function streamTurn(turn: PreparedTurn, rawSend: SendEvent, deps: StreamTurnDeps = {}): Promise<void> {
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
    // 원문(결제 상태·키 오류 등)은 운영 기록에만 남기고 직원에게는 할 일을 알려 주는 안내만 보낸다.
    // 크레딧·키 문제는 직원이 기다려도 풀리지 않으므로 슈퍼관리자 로그에서 바로 보이게 critical로 둔다.
    const kind = error instanceof LlmApiError ? llmErrorKind(error) : null;
    await logSystem({
      level: kind === 'unavailable' ? 'critical' : 'error',
      category: 'api',
      message: kind === 'unavailable' ? 'AI 서비스 사용 불가(결제·키 확인 필요)' : 'AI 응답 생성 실패',
      details: {
        error: error instanceof Error ? error.message : String(error),
        status: error instanceof LlmApiError ? error.status : null,
        model: turn.modelId,
      },
      orgId: turn.ctx.organizationId,
    });
    send({ event: 'error', data: { message: friendlyLlmMessage(error) ?? GENERIC_TURN_ERROR } });
    return;
  }

  // 숫자 확인(설계 5.4, S4-b 판정 R1) — 첨부 도구가 성공했거나 문서 근거가 있었던 턴만. 시스템 프롬프트(첨부 개요의
  // 행 수·NODA 근거 묶음)와 직원의 질문에 적힌 숫자, 도구가 보여 준 숫자(법령·통계 포함)가 AI가 본 숫자다 — 그 합집합에
  // 없는 숫자만 '확인되지 않음'. 답변 글은 고치지 않는다
  let numberCheck: { unverified: string[] } | null = null;
  if (result.attachmentToolSucceeded || turn.chunks.length > 0) {
    const shown = result.shownValues.concat(numbersIn(turn.systemPrompt), numbersIn(turn.ctx.message));
    const unverified = checkNumbers(result.text, shown);
    if (unverified.length > 0) numberCheck = { unverified };
  }

  // NODA 답변 검증 — 저장 전에 불러 결과를 함께 저장한다(감사 기록). 화면 목록에는 더하지 않는다(판정 R1)
  const verify = await verifyTurn(turn, result.text, deps.verify ?? defaultVerify);

  const saveError = await saveMessages(
    buildMessageRows({
      conversationId: turn.conversationId,
      userId: turn.ctx.userId,
      userContent: turn.storedUserContent,
      assistantText: result.text,
      chunks: turn.chunks,
      links: result.links,
      files: result.files,
      attachments: turn.ctx.attachments.filter((a) => a.isNew).map((a) => ({ id: a.id, file_name: a.fileName })),
      agentVersion: turn.ctx.agentVersion,
      numberCheck,
      documentsSkipped: turn.documentsSkipped,
      verify,
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

  send({ event: 'done', data: { usage: result.usage, title, number_check: numberCheck } });
}
