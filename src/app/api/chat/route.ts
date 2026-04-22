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

    // 사용자의 부서 확인
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('department_id')
      .eq('id', session.user.id)
      .single();

    if (userError || !user?.department_id) {
      return NextResponse.json(
        { ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } },
        { status: 403 }
      );
    }

    // 에이전트 확인 및 권한 체크
    const { data: agent, error: agentError } = await supabaseAdmin
      .from('agents')
      .select('id, department_id, system_prompt, name')
      .eq('id', agent_id)
      .eq('is_active', true)
      .single();

    if (agentError || !agent) {
      return NextResponse.json(
        { ok: false, error: { message: '에이전트를 찾을 수 없습니다.' } },
        { status: 404 }
      );
    }

    if (agent.department_id !== user.department_id) {
      return NextResponse.json(
        { ok: false, error: { message: '해당 에이전트에 접근할 권한이 없습니다.' } },
        { status: 403 }
      );
    }

    // 입력 필터링
    const filterResult = await filterUserInput(user.department_id, message);
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
          department_id: user.department_id,
          agent_id: agent_id,
          user_id: session.user.id,
          title: `대화 with ${agent.name}`,
        })
        .select()
        .single();

      if (convError) {
        return NextResponse.json(
          { ok: false, error: { message: '대화 생성 중 오류가 발생했습니다.' } },
          { status: 500 }
        );
      }
      conversation = newConv;
    }

    // 관련 청크 검색
    const retrievalResult = await retrieveRelevantChunks(agent_id, message);

    // Claude 메시지 구성
    const contextText = retrievalResult.chunks
      .map((chunk) => `[참고 자료: ${chunk.documentTitle || '문서'}]\n${chunk.text}`)
      .join('\n\n');

    const systemMessage = agent.system_prompt || '당신은 도움이 되는 AI 어시스턴트입니다.';
    const fullSystemPrompt = `${systemMessage}\n\n참고 자료:\n${contextText}`;

    const claudeMessages: ClaudeMessage[] = [
      { role: 'user', content: message },
    ];

    // Claude API 호출
    const claudeResponse = await callClaudeAPI(claudeMessages, fullSystemPrompt);

    // 응답 조립
    const finalResponse = assembleResponse(message, retrievalResult.chunks, claudeResponse.content);

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
      department_id: user.department_id,
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
  } catch (error) {
    console.error('채팅 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}