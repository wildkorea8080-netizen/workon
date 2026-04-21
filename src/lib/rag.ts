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
  if (!agentId) throw new Error('에이전트 ID가 필요합니다.');
  if (!query.trim()) throw new Error('쿼리가 비어있습니다.');

  const queryEmbeddings = await getEmbeddings([query]);
  const queryEmbedding = queryEmbeddings[0];

  const { data, error } = await supabaseAdmin.rpc('search_agent_chunks', {
    query_embedding: queryEmbedding,
    match_threshold: MATCH_THRESHOLD,
    match_count: MATCH_COUNT,
    p_agent_id: agentId,
  });

  if (error) {
    throw new Error('문서 검색 중 오류가 발생했습니다: ' + error.message);
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
