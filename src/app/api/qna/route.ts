import { NextRequest, NextResponse } from 'next/server';
import { resolveModelForDepartment } from '@/lib/model-policy';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getEmbeddings } from '@/lib/embeddings';
import { callClaudeAPI, type ClaudeMessage } from '@/lib/claude';
import { MATCH_THRESHOLD, MATCH_COUNT } from '@/lib/rag';
import { estimateCostUsd, estimateCostKrw } from '@/lib/models';
import { checkTokenLimit, limitMessage } from '@/lib/usage-limit';

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
    const { query } = body;

    if (!query || typeof query !== 'string' || !query.trim()) {
      return NextResponse.json(
        { ok: false, error: { message: '질문 내용이 필요합니다.' } },
        { status: 400 }
      );
    }

    const departmentId = session.user.departmentId;
    if (!departmentId) {
      return NextResponse.json(
        { ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } },
        { status: 403 }
      );
    }


    // 토큰을 소비하는 라우트는 한도를 확인해야 한다. 이 검사가 없어서
    // 예산을 소진한 기관도 이 경로로는 계속 쓸 수 있었다 — 차단이
    // 동작한다고 믿는데 새는 구멍이 남아 있던 자리다.
    const limitStatus = await checkTokenLimit(departmentId, session.user.id);
    if (!limitStatus.allowed) {
      return NextResponse.json(
        { ok: false, error: { message: limitMessage(limitStatus) } },
        { status: 429 }
      );
    }

    // 쿼리 임베딩 생성
    const queryEmbeddings = await getEmbeddings([query]);
    const queryEmbedding = queryEmbeddings[0];

    // 부서 전체 문서 청크 검색 (pgvector RPC)
    const { data: chunks, error: searchError } = await supabaseAdmin.rpc(
      'search_document_chunks',
      {
        query_embedding: queryEmbedding,
        match_threshold: MATCH_THRESHOLD,
        match_count: MATCH_COUNT,
        p_department_id: departmentId,
      }
    );

    if (searchError) {
      console.error('문서 검색 오류:', searchError);
      return NextResponse.json(
        { ok: false, error: { message: '문서 검색 중 오류가 발생했습니다.' } },
        { status: 500 }
      );
    }

    if (!chunks || chunks.length === 0) {
      return NextResponse.json({
        ok: true,
        data: {
          answer: '관련된 문서를 찾을 수 없습니다. 다른 질문으로 시도해보세요.',
          sources: [],
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    }

    const contextText = chunks
      .map((chunk: any) => `[${chunk.document_title}]\n${chunk.content}`)
      .join('\n\n---\n\n');

    const systemPrompt = `당신은 전문적인 내부 문서 Q&A 어시스턴트입니다.

다음 지침을 따라 답변하세요:
- 제공된 내부 문서 내용만을 기반으로 답변하세요
- 문서에 없는 내용은 추측하거나 추가하지 마세요
- 정중하고 전문적인 한국어 비즈니스 문체를 사용하세요
- 답변이 불가능한 경우 솔직하게 말하세요
- 출처 문서를 명확히 표시하세요
- 답변을 구조화하여 읽기 쉽게 하세요`;

    const userPrompt = `질문: ${query}

관련 문서 내용:
${contextText}

위 문서 내용을 바탕으로 질문에 답변해주세요.`;

    const claudeMessages: ClaudeMessage[] = [
      { role: 'user', content: userPrompt },
    ];

    // 기관별 허용 모델 정책(0021). 이 라우트도 토큰을 쓰므로 정책 밖에 두면 안 된다.
    const modelId = await resolveModelForDepartment(departmentId);
    const claudeResponse = await callClaudeAPI(claudeMessages, systemPrompt, 2048, modelId);

    const sources = chunks.map((chunk: any) => ({
      document_title: chunk.document_title,
      chunk_content: (chunk.content as string).substring(0, 200) + '...',
      similarity: chunk.similarity,
    }));

    // 사용 로그
    await supabaseAdmin.from('usage_logs').insert({
      department_id: departmentId,
      user_id: session.user.id,
      action: 'qna_search',
      resource_type: 'document_qna',
      details: {
        query,
        chunks_found: chunks.length,
        model: claudeResponse.usage.model,
        input_tokens: claudeResponse.usage.input_tokens,
        output_tokens: claudeResponse.usage.output_tokens,
        cost_usd: estimateCostUsd(claudeResponse.usage, claudeResponse.usage.model),
        cost_krw: estimateCostKrw(claudeResponse.usage, claudeResponse.usage.model),
      },
    });

    return NextResponse.json({
      ok: true,
      data: {
        answer: claudeResponse.content,
        sources,
        usage: claudeResponse.usage,
      },
    });
  } catch (error) {
    console.error('Q&A 검색 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '검색 중 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
