import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { callClaudeAPI, type ClaudeMessage } from '@/lib/claude';
import { retrieveRelevantChunks, assembleResponse } from '@/lib/rag';
import { filterUserInput } from '@/lib/filter';
import type { Conversation, Message } from '@/lib/db';

export async function POST(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: { message: '인증이 필요합니다.' } },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { agent_id, message, conversation_id } = body;

    if (!agent_id || typeof agent_id !== 'string') {
      return NextResponse.json(
        { ok: false, error: { message: '에이전트 ID는 필수입니다.' } },
        { status: 400 }
      );
    }

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return NextResponse.json(
        { ok: false, error: { message: '메시지는 필수입니다.' } },
        { status: 400 }
      );
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
      return NextResponse.json(
        { ok: false, error: { message: '부서 정보를 찾을 수 없습니다. 관리자에게 문의하세요.' } },
        { status: 403 }
      );
    }

    // 에이전트 확인
    const { data: agent, error: agentError } = await supabaseAdmin
      .from('agents')
      .select('id, department_id, system_prompt, name, is_personal, owner_id')
      .eq('id', agent_id)
      .eq('is_active', true)
      .single();

    if (agentError || !agent) {
      return NextResponse.json(
        { ok: false, error: { message: '에이전트를 찾을 수 없습니다.' } },
        { status: 404 }
      );
    }

    // 접근 권한: 같은 부서 에이전트 OR 내 나만의 비서
    const canAccess =
      agent.department_id === departmentId ||
      (agent.is_personal && agent.owner_id === session.user.id);

    if (!canAccess) {
      return NextResponse.json(
        { ok: false, error: { message: '해당 에이전트에 접근할 권한이 없습니다.' } },
        { status: 403 }
      );
    }

    // 입력 필터링
    const filterResult = await filterUserInput(departmentId, message);
    if (!filterResult.isValid) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            message: '메시지에 금지된 내용이 포함되어 있습니다.',
            details: {
              blockedWords: filterResult.blockedWords,
              blockedPatterns: filterResult.blockedPatterns,
            },
          },
        },
        { status: 400 }
      );
    }

    let conversation: Conversation;
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
        return NextResponse.json(
          { ok: false, error: { message: '대화를 찾을 수 없습니다.' } },
          { status: 404 }
        );
      }
      conversation = existingConv;
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
        return NextResponse.json(
          { ok: false, error: { message: `대화 생성 실패: ${convError.message}` } },
          { status: 500 }
        );
      }
      conversation = newConv;
    }

    // 관련 청크 검색 (실패해도 빈 결과로 계속)
    let retrievalResult;
    try {
      retrievalResult = await retrieveRelevantChunks(agent_id, message);
    } catch {
      retrievalResult = { query: message, chunks: [], totalChunks: 0 };
    }

    // Claude 메시지 구성 (RAG 문서가 있을 때만 참고 자료 추가)
    const systemMessage = agent.system_prompt || '당신은 도움이 되는 AI 어시스턴트입니다.';
    const contextText = retrievalResult.chunks
      .map((chunk) => `[참고 자료: ${chunk.documentTitle || '문서'}]\n${chunk.text}`)
      .join('\n\n');
    const fullSystemPrompt = contextText
      ? `${systemMessage}\n\n참고 자료:\n${contextText}`
      : systemMessage;

    const claudeMessages: ClaudeMessage[] = [
      { role: 'user', content: message },
    ];

    // Claude API 호출
    const claudeResponse = await callClaudeAPI(claudeMessages, fullSystemPrompt);

    // 응답 조립 (RAG 없으면 Claude 응답 그대로)
    const finalResponse = retrievalResult.chunks.length > 0
      ? assembleResponse(message, retrievalResult.chunks, claudeResponse.content)
      : claudeResponse.content;

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
        content: claudeResponse.content,
        source_references: {
          chunks: retrievalResult.chunks.map((c) => ({
            documentId: c.documentId,
            documentTitle: c.documentTitle,
            chunkIndex: c.chunkIndex,
            similarity: c.similarity,
          })),
        },
      },
    ]);

    if (msgError) {
      console.error('메시지 저장 오류:', msgError);
      // 메시지 저장 실패해도 응답은 반환
    }

    // 새 대화일 때 제목 자동 생성 (비동기, 실패해도 무방)
    if (!conversation_id) {
      (async () => {
        try {
          const titleResponse = await callClaudeAPI(
            [{ role: 'user', content: `다음 질문을 20자 이내 한국어 제목으로 요약해줘. 제목만 출력하고 다른 설명은 하지 마: "${message}"` }],
            undefined,
            40
          );
          const autoTitle = titleResponse.content.trim().replace(/^["']|["']$/g, '').slice(0, 30);
          if (autoTitle) {
            await supabaseAdmin
              .from('conversations')
              .update({ title: autoTitle })
              .eq('id', conversation.id);
          }
        } catch {
          // 제목 생성 실패는 무시
        }
      })();
    }

    // 사용 로그 기록
    await supabaseAdmin.from('usage_logs').insert({
      department_id: departmentId,
      user_id: session.user.id,
      action: 'chat_message',
      resource_type: 'conversation',
      resource_id: conversation.id,
      details: {
        agent_id,
        input_tokens: claudeResponse.usage.input_tokens,
        output_tokens: claudeResponse.usage.output_tokens,
        chunks_retrieved: retrievalResult.chunks.length,
      },
    });

    return NextResponse.json({
      ok: true,
      data: {
        conversation_id: conversation.id,
        response: finalResponse,
        chunks: retrievalResult.chunks,
        usage: claudeResponse.usage,
      },
    });
  } catch (error: any) {
    console.error('채팅 오류:', error);
    // Claude API 키 오류는 명확한 메시지 반환
    const msg = error?.message ?? '서버 오류가 발생했습니다.';
    return NextResponse.json(
      { ok: false, error: { message: msg } },
      { status: 500 }
    );
  }
}