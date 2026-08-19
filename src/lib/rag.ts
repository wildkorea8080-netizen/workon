import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getEmbeddings } from '@/lib/embeddings';
import type { RetrievedChunk, RetrievalResult } from '@/lib/db';

/**
 * 코사인 유사도 하한.
 *
 * 0.72였는데 그 값으로는 **어떤 문서도 통과한 적이 없다.** voyage-3의 한국어
 * 유사도 분포를 실측한 결과다(2026-08-19, 공문 HWP 1건 기준):
 *
 *   관련 질문   0.41 ~ 0.49   (참여자격 / 반입가능물량 / 자격 요건)
 *   무관 질문   0.02 ~ 0.11   (요리 / 코딩 / 날씨 / 연차)
 *
 * 무관 질문조차 0.11을 넘지 못하므로 0.25면 약 2배 여유를 두고 갈린다.
 * 상한을 높게 잡는 것보다 top-k(MATCH_COUNT)가 순위로 걸러내게 하는 편이
 * 안전하다 — 임계값은 "아무것도 관련 없을 때 빈 결과를 주기 위한 바닥"이다.
 *
 * 문서가 늘면 분포가 달라질 수 있다. 바꿀 때는 감이 아니라
 * 관련/무관 질문을 각각 몇 개 측정해 분리 구간을 확인하고 정할 것.
 */
export const MATCH_THRESHOLD = 0.25;
export const MATCH_COUNT = 5;

/**
 * 에이전트에 속한 문서 청크를 pgvector로 검색합니다.
 * Supabase의 search_agent_chunks RPC (0004 마이그레이션)를 사용합니다.
 */
export async function retrieveRelevantChunks(
  agentId: string,
  query: string
): Promise<RetrievalResult> {
  if (!agentId) return { query, chunks: [], totalChunks: 0 };
  if (!query.trim()) return { query, chunks: [], totalChunks: 0 };

  // Voyage AI 임베딩 실패 시 RAG 없이 Claude만 사용
  let queryEmbedding: number[];
  try {
    const queryEmbeddings = await getEmbeddings([query]);
    queryEmbedding = queryEmbeddings[0];
  } catch (embErr: any) {
    console.warn('[RAG] 임베딩 실패 (문서 없이 진행):', embErr.message);
    return { query, chunks: [], totalChunks: 0 };
  }

  const { data, error } = await supabaseAdmin.rpc('search_agent_chunks', {
    query_embedding: queryEmbedding,
    match_threshold: MATCH_THRESHOLD,
    match_count: MATCH_COUNT,
    p_agent_id: agentId,
  });

  if (error) {
    console.warn('[RAG] search_agent_chunks 실패 (문서 없이 진행):', error.message);
    return { query, chunks: [], totalChunks: 0 };
  }

  const chunks: RetrievedChunk[] = (data ?? []).map((row: any) => ({
    documentId: row.document_id,
    documentTitle: row.document_title ?? undefined,
    chunkIndex: row.chunk_index,
    text: row.content,
    similarity: row.similarity,
  }));

  return {
    query,
    chunks,
    totalChunks: chunks.length,
  };
}

// NOTE: 출처 표기는 응답 텍스트에 덧붙이지 않고 source_references 메타데이터로
// 전달해 SourceCitation 컴포넌트가 렌더링한다. 텍스트에 덧붙이던 예전 방식은
// DB에 저장되는 내용과 화면에 보이는 내용이 달라지는 문제가 있었다.
