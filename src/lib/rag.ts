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

export function formatSourceReferences(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return '참고 자료가 없습니다.';

  const sources = chunks.map((chunk, index) => {
    const title = chunk.documentTitle || `문서 ${chunk.documentId.slice(0, 8)}`;
    return `${index + 1}. ${title} (청크 ${chunk.chunkIndex + 1}, 유사도: ${(chunk.similarity * 100).toFixed(1)}%)`;
  });

  return '참고 자료:\n' + sources.join('\n');
}

export function assembleResponse(
  _query: string,
  chunks: RetrievedChunk[],
  aiResponse: string
): string {
  const sources = formatSourceReferences(chunks);
  return `${aiResponse}\n\n${sources}`;
}
