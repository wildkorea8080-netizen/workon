import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  streamClaudeAPI,
  callClaudeAPI,
  CLAUDE_MODEL,
  type ClaudeMessage,
  type ClaudeUsage,
  type ClaudeContentBlock,
  type ClaudeTool,
} from '@/lib/claude';
import { toolsForConnectors, executeTool, type ToolSource } from '@/lib/connectors';
import { retrieveRelevantChunks } from '@/lib/rag';
import { filterUserInput } from '@/lib/filter';
import { checkTokenLimit } from '@/lib/usage-limit';
import type { Conversation, RetrievedChunk } from '@/lib/db';
import { estimateCostUsd, estimateCostKrw } from '@/lib/models';

/** Claude에 함께 보낼 직전 대화 메시지 최대 개수 (사용자+어시스턴트 합산) */
const HISTORY_MESSAGE_LIMIT = 20;

/** 툴 호출 왕복 상한. 모델이 툴만 반복해서 부르는 상황을 끊는다. */
const MAX_TOOL_ROUNDS = 4;

function jsonError(message: string, status: number, details?: unknown) {
  return NextResponse.json(
    { ok: false, error: details ? { message, details } : { message } },
    { status }
  );
}

/** SSE 한 줄로 직렬화 */
function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return jsonError('인증이 필요합니다.', 401);
    }

    const body = await request.json();
    const { agent_id, message, conversation_id } = body;

    if (!agent_id || typeof agent_id !== 'string') {
      return jsonError('에이전트 ID는 필수입니다.', 400);
    }

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return jsonError('메시지는 필수입니다.', 400);
    }

    // 부서 확인: 세션 캐시 우선, 없으면 DB 조회, 그래도 없으면 첫 번째 부서 자동 배정
    let departmentId: string | null = session.user.departmentId ?? null;

    if (!departmentId) {
      const { data: dbUser } = await supabaseAdmin
        .from('users')
        .select('department_id')
        .eq('id', session.user.id)
        .single();
      departmentId = dbUser?.department_id ?? null;
    }

    if (!departmentId) {
      // 마지막 수단: 첫 번째 부서 자동 배정
      const { data: firstDept } = await supabaseAdmin
        .from('departments')
        .select('id')
        .order('created_at', { ascending: true })
        .limit(1)
        .single();
      if (firstDept?.id) {
        departmentId = firstDept.id;
        await supabaseAdmin
          .from('users')
          .update({ department_id: firstDept.id })
          .eq('id', session.user.id);
      }
    }

    if (!departmentId) {
      return jsonError('부서 정보를 찾을 수 없습니다. 관리자에게 문의하세요.', 403);
    }

    // 기관 상태 + 월 토큰 한도 확인
    const limitStatus = await checkTokenLimit(departmentId);
    if (!limitStatus.allowed) {
      const message =
        limitStatus.reason === 'org_suspended'
          ? '기관 이용이 정지되었습니다. 관리자에게 문의하세요.'
          : `이번 달 사용 한도를 모두 사용했습니다. (${limitStatus.usedTokens.toLocaleString()} / ${limitStatus.limitTokens.toLocaleString()} 토큰) 관리자에게 문의하세요.`;
      return jsonError(message, 429, {
        reason: limitStatus.reason,
        usedTokens: limitStatus.usedTokens,
        limitTokens: limitStatus.limitTokens,
      });
    }

    // 에이전트 확인
    const { data: agent, error: agentError } = await supabaseAdmin
      .from('agents')
      .select('id, department_id, system_prompt, name, is_personal, owner_id, enabled_connectors')
      .eq('id', agent_id)
      .eq('is_active', true)
      .single();

    if (agentError || !agent) {
      return jsonError('에이전트를 찾을 수 없습니다.', 404);
    }

    // 접근 권한: 같은 부서 에이전트 OR 내 나만의 비서
    const canAccess =
      agent.department_id === departmentId ||
      (agent.is_personal && agent.owner_id === session.user.id);

    if (!canAccess) {
      return jsonError('해당 에이전트에 접근할 권한이 없습니다.', 403);
    }

    // 입력 필터링
    const filterResult = await filterUserInput(departmentId, message);
    if (!filterResult.isValid) {
      return jsonError('메시지에 금지된 내용이 포함되어 있습니다.', 400, {
        blockedWords: filterResult.blockedWords,
        blockedPatterns: filterResult.blockedPatterns,
      });
    }

    let conversation: Conversation;
    let history: ClaudeMessage[] = [];

    if (conversation_id) {
      // 기존 대화 확인
      const { data: existingConv, error: convError } = await supabaseAdmin
        .from('conversations')
        .select('*')
        .eq('id', conversation_id)
        .eq('user_id', session.user.id)
        .eq('agent_id', agent_id)
        .single();

      if (convError || !existingConv) {
        return jsonError('대화를 찾을 수 없습니다.', 404);
      }
      conversation = existingConv;

      // 직전 대화 이력을 불러와 멀티턴 문맥을 유지한다.
      // 최신 N개를 가져온 뒤 시간순으로 되돌린다.
      const { data: pastMessages } = await supabaseAdmin
        .from('messages')
        .select('role, content')
        .eq('conversation_id', conversation.id)
        .order('created_at', { ascending: false })
        .limit(HISTORY_MESSAGE_LIMIT);

      history = (pastMessages ?? [])
        .reverse()
        .filter(
          (m: { role: string; content: string }) =>
            (m.role === 'user' || m.role === 'assistant') && m.content?.trim()
        )
        .map((m: { role: string; content: string }) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));

      // Claude는 user 메시지로 시작해야 한다. assistant로 시작하면 앞을 잘라낸다.
      while (history.length > 0 && history[0].role !== 'user') {
        history.shift();
      }
    } else {
      // 새 대화 생성
      const { data: newConv, error: convError } = await supabaseAdmin
        .from('conversations')
        .insert({
          department_id: departmentId,
          agent_id: agent_id,
          user_id: session.user.id,
          title: `대화 with ${agent.name}`,
        })
        .select()
        .single();

      if (convError) {
        console.error('[chat] conversation insert error:', convError);
        return jsonError(`대화 생성 실패: ${convError.message}`, 500);
      }
      conversation = newConv;
    }

    // 관련 청크 검색 (실패해도 빈 결과로 계속)
    let chunks: RetrievedChunk[] = [];
    try {
      const retrievalResult = await retrieveRelevantChunks(agent_id, message);
      chunks = retrievalResult.chunks;
    } catch {
      chunks = [];
    }

    // Claude 프롬프트 조립 (RAG 문서가 있을 때만 참고 자료 추가)
    const systemMessage = agent.system_prompt || '당신은 도움이 되는 AI 어시스턴트입니다.';
    const contextText = chunks
      .map((chunk) => `[참고 자료: ${chunk.documentTitle || '문서'}]\n${chunk.text}`)
      .join('\n\n');
    const fullSystemPrompt = contextText
      ? `${systemMessage}\n\n참고 자료:\n${contextText}`
      : systemMessage;

    const claudeMessages: ClaudeMessage[] = [...history, { role: 'user', content: message }];

    // 이 에이전트에 허용된 커넥터의 툴만 노출한다.
    // MCP 형식 → Anthropic 형식 변환은 이 어댑터 계층의 책임이며,
    // 커넥터는 프로바이더를 모른다.
    const agentTools = toolsForConnectors(agent.enabled_connectors);
    const allowedToolNames = new Set(agentTools.map((tool) => tool.name));
    const tools: ClaudeTool[] = agentTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));

    const isNewConversation = !conversation_id;
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown) =>
          controller.enqueue(encoder.encode(sse(event, data)));

        let fullText = '';
        const usage: ClaudeUsage = { input_tokens: 0, output_tokens: 0, model: CLAUDE_MODEL };
        const toolSources: ToolSource[] = [];

        try {
          // 대화 ID와 출처는 먼저 보내 클라이언트가 즉시 반영할 수 있게 한다
          send('meta', { conversation_id: conversation.id, chunks });

          // 툴 실행 루프: 모델이 툴을 부르면 실행 결과를 붙여 다시 호출한다.
          // 무한 왕복을 막기 위해 라운드 수를 제한한다.
          for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            const assistantBlocks: ClaudeContentBlock[] = [];
            const pendingCalls: { id: string; name: string; input: Record<string, unknown> }[] = [];
            let roundText = '';
            let stopReason: string | null = null;

            for await (const event of streamClaudeAPI(
              claudeMessages,
              fullSystemPrompt,
              4096,
              tools
            )) {
              if (event.type === 'text') {
                roundText += event.text;
                fullText += event.text;
                send('delta', { text: event.text });
              } else if (event.type === 'tool_use') {
                pendingCalls.push({ id: event.id, name: event.name, input: event.input });
              } else {
                usage.input_tokens += event.usage.input_tokens;
                usage.output_tokens += event.usage.output_tokens;
                stopReason = event.stopReason;
              }
            }

            if (stopReason !== 'tool_use' || pendingCalls.length === 0) break;

            // 모델이 만든 턴을 그대로 대화에 추가한다 (텍스트 + tool_use 블록)
            if (roundText) assistantBlocks.push({ type: 'text', text: roundText });
            for (const call of pendingCalls) {
              assistantBlocks.push({
                type: 'tool_use',
                id: call.id,
                name: call.name,
                input: call.input,
              });
            }
            claudeMessages.push({ role: 'assistant', content: assistantBlocks });

            // 툴 실행 결과를 사용자 턴으로 되돌려준다
            const resultBlocks: ClaudeContentBlock[] = [];
            for (const call of pendingCalls) {
              send('tool_start', { name: call.name, input: call.input });

              // 모델은 노출된 툴만 부를 수 있지만, 실행 직전에 한 번 더 확인한다
              const result = allowedToolNames.has(call.name)
                ? await executeTool(call.name, call.input)
                : { content: `허용되지 않은 도구입니다: ${call.name}`, sources: [], isError: true };
              toolSources.push(...result.sources);

              send('tool_end', {
                name: call.name,
                ok: !result.isError,
                sources: result.sources,
              });

              resultBlocks.push({
                type: 'tool_result',
                tool_use_id: call.id,
                content: result.content,
                is_error: result.isError,
              });
            }
            claudeMessages.push({ role: 'user', content: resultBlocks });

            if (round === MAX_TOOL_ROUNDS - 1) {
              console.warn('[chat] 툴 라운드 상한 도달');
            }
          }
        } catch (error: any) {
          console.error('[chat] streaming error:', error);
          send('error', { message: error?.message ?? '응답 생성 중 오류가 발생했습니다.' });
          controller.close();
          return;
        }

        // 메시지 저장
        const { error: msgError } = await supabaseAdmin.from('messages').insert([
          {
            conversation_id: conversation.id,
            user_id: session.user.id,
            role: 'user',
            content: message,
          },
          {
            conversation_id: conversation.id,
            role: 'assistant',
            content: fullText,
            source_references: {
              chunks: chunks.map((c) => ({
                documentId: c.documentId,
                documentTitle: c.documentTitle,
                chunkIndex: c.chunkIndex,
                similarity: c.similarity,
              })),
              // 외부 도구가 돌려준 출처 (중복 URL 제거)
              links: toolSources.filter(
                (source, index, all) =>
                  all.findIndex((other) => other.url === source.url) === index
              ),
            },
          },
        ]);

        if (msgError) {
          console.error('[chat] 메시지 저장 오류:', msgError);
        }

        // 사용 로그 기록 (organization_id는 0012 트리거가 department_id로부터 채움)
        await supabaseAdmin.from('usage_logs').insert({
          department_id: departmentId,
          user_id: session.user.id,
          action: 'chat_message',
          resource_type: 'conversation',
          resource_id: conversation.id,
          details: {
            agent_id,
            model: usage.model,
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            // 기록 시점의 단가로 원가를 확정해 둔다. 나중에 단가가 바뀌어도
            // 과거 정산이 흔들리지 않는다.
            cost_usd: estimateCostUsd(usage, usage.model),
            cost_krw: estimateCostKrw(usage, usage.model),
            chunks_retrieved: chunks.length,
          },
        });

        // 새 대화면 제목 자동 생성 (실패해도 무방)
        let title: string | null = null;
        if (isNewConversation) {
          try {
            const titleResponse = await callClaudeAPI(
              [
                {
                  role: 'user',
                  content: `다음 질문을 20자 이내 한국어 제목으로 요약해줘. 제목만 출력하고 다른 설명은 하지 마: "${message}"`,
                },
              ],
              undefined,
              40
            );
            const autoTitle = titleResponse.content.trim().replace(/^["']|["']$/g, '').slice(0, 30);
            if (autoTitle) {
              await supabaseAdmin
                .from('conversations')
                .update({ title: autoTitle })
                .eq('id', conversation.id);
              title = autoTitle;
            }
          } catch {
            // 제목 생성 실패는 무시
          }
        }

        send('done', { usage, title });
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Vercel/nginx 프록시가 스트림을 버퍼링하지 않도록
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error: any) {
    console.error('채팅 오류:', error);
    return jsonError(error?.message ?? '서버 오류가 발생했습니다.', 500);
  }
}
