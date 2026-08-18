import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getEmbeddings } from '@/lib/embeddings';
import type { RetrievedChunk, RetrievalResult } from '@/lib/db';

export const MATCH_THRESHOLD = 0.72;
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
