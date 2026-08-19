-- =============================================================
-- 0015_department_sharing.sql
-- 부서 계층 기반 자료 공유
--
-- 0014에서 parent_id로 계층을 만들었지만 실제 공유에는 쓰이지 않고 있었다.
-- 이제 상위 부서에 등록한 비서를 하위 부서가 함께 쓸 수 있게 한다.
--
-- 방향이 두 가지라 헷갈리기 쉬우므로 이름을 분명히 한다:
--   department_ancestors(D)   D와 D의 모든 상위 부서
--                             → "D 소속 직원에게 보여야 할 자료의 소유 부서"
--   department_descendants(D) D와 D의 모든 하위 부서 (0014에서 추가)
--                             → "D에 공유하면 실제로 보게 될 부서"
--
-- 예: 기관 > 경영지원본부 > 법무실 > 계약팀
--   계약팀 직원은 계약팀·법무실·경영지원본부·기관의 비서를 모두 볼 수 있다.
--   경영지원본부에 비서를 만들면 그 아래 전 부서가 쓴다.
-- =============================================================

CREATE OR REPLACE FUNCTION department_ancestors(p_department_id uuid)
RETURNS TABLE (id uuid)
LANGUAGE sql
STABLE
AS $$
  WITH RECURSIVE tree AS (
    SELECT d.id, d.parent_id
      FROM departments d
     WHERE d.id = p_department_id
    UNION ALL
    SELECT d.id, d.parent_id
      FROM departments d
      JOIN tree t ON d.id = t.parent_id
  )
  SELECT id FROM tree;
$$;

COMMENT ON FUNCTION department_ancestors(uuid) IS
  '주어진 부서와 그 모든 상위 부서의 id. 해당 부서 직원이 접근 가능한 자료 범위를 구할 때 쓴다.';


-- ── 부서 전체 문서 검색을 상위 부서까지 확장 ─────────────────
-- /api/qna가 쓰는 RPC. 기존에는 자기 부서 문서만 검색해, 상위 부서에 올린
-- 공통 규정·지침을 하위 부서에서 찾을 수 없었다.
--
-- 0003의 구현을 그대로 두고 WHERE 절의 부서 조건만 확장한다.
-- (반환 컬럼 순서와 타입은 0003과 동일해야 애플리케이션이 그대로 동작한다)
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
    1 - (
      (chunk_elem->'embedding')::text::vector(1024)
      <=>
      query_embedding
    ) as similarity
  from
    documents d,
    jsonb_array_elements(d.metadata->'chunks') as chunk_elem
  where
    -- 여기만 바뀌었다: 자기 부서 → 자기 부서 + 모든 상위 부서
    d.department_id in (select id from department_ancestors(p_department_id))
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


-- ── 확인 ──────────────────────────────────────────────────────
-- 각 부서에서 보이는 상위 부서 수 (자기 자신 포함이라 최소 1)
SELECT
  d.name,
  (SELECT count(*) FROM department_ancestors(d.id)) AS visible_levels
FROM departments d
ORDER BY visible_levels DESC
LIMIT 10;
