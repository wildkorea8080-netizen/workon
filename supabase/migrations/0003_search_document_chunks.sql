-- search_document_chunks: 부서 내 문서 청크를 벡터 유사도로 검색합니다.
--
-- 청크 임베딩은 documents.metadata->'chunks' JSONB 배열에 저장되어 있으며
-- 각 청크는 { index, text, embedding } 구조를 가집니다.
-- 문서 레벨 평균 임베딩(documents.embedding)으로 1차 필터링 후
-- 청크별 코사인 유사도를 계산하여 반환합니다.
create or replace function search_document_chunks(
  query_embedding vector(1024),
  match_threshold float,
  match_count int,
  p_department_id uuid
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
    -- chunk 임베딩을 vector로 캐스팅해 코사인 유사도 계산
    1 - (
      (chunk_elem->'embedding')::text::vector(1024)
      <=>
      query_embedding
    ) as similarity
  from
    documents d,
    jsonb_array_elements(d.metadata->'chunks') as chunk_elem
  where
    d.department_id = p_department_id
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
