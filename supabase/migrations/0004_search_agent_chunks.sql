-- search_agent_chunks: 특정 에이전트에 속한 문서 청크를 벡터 유사도로 검색합니다.
--
-- /api/chat 에서 에이전트 기반 RAG 검색에 사용됩니다.
-- 청크 임베딩은 documents.metadata->'chunks' JSONB 배열에 저장되어 있으며
-- 각 청크는 { index, text, embedding } 구조를 가집니다.
create or replace function search_agent_chunks(
  query_embedding vector(1024),
  match_threshold float,
  match_count int,
  p_agent_id uuid
)
returns table (
  document_id uuid,
  document_title text,
  content text,
  chunk_index int,
  similarity float
)
language plpgsql
stable
as $$
begin
  return query
  select
    d.id as document_id,
    coalesce(d.title, d.file_name) as document_title,
    (chunk_elem->>'text') as content,
    (chunk_elem->>'index')::int as chunk_index,
    1 - (
      (chunk_elem->'embedding')::text::vector(1024)
      <=>
      query_embedding
    ) as similarity
  from
    documents d,
    jsonb_array_elements(d.metadata->'chunks') as chunk_elem
  where
    d.agent_id = p_agent_id
    and d.metadata->'chunks' is not null
    and 1 - (
      (chunk_elem->'embedding')::text::vector(1024)
      <=>
      query_embedding
    ) >= match_threshold
  order by
    similarity desc
  limit match_count;
end;
$$;
