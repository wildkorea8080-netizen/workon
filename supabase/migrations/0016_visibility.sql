-- =============================================================
-- 0016_visibility.sql
-- 공개 범위: 기관 전체가 기본, 부서 제한은 예외
--
-- 배경:
--   지금까지는 비서·문서가 만든 사람의 부서에 묶였고, 다른 부서에서 보려면
--   상위 부서에 배치해야 했다. 이건 그룹웨어의 발상이다.
--
--   공공기관 규정 대부분은 전 직원 공통이다 (복무·여비·문서관리·정보공개·
--   행동강령). 부서로 나누면 오히려 못 찾는다. 게다가 정기 인사이동 때마다
--   부서 트리와 문서 배치를 다시 손봐야 한다.
--
--   그래서 기본값을 뒤집는다. 기관 전체 공개가 기본이고, 인사·감사·법무처럼
--   제한이 필요한 것만 부서로 좁힌다. 부서 계층(0014·0015)은 버려지지 않고
--   '부서 제한'일 때 상위→하위 상속에 그대로 쓰인다.
--
--   organization_id는 department_id에서 트리거로 유도한다 (0012와 같은 방식).
--   조회할 때마다 departments를 조인하지 않기 위해서다.
-- =============================================================

-- ── 1. 컬럼 추가 ─────────────────────────────────────────────
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'organization',
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'organization',
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_visibility_check') THEN
    ALTER TABLE agents ADD CONSTRAINT agents_visibility_check
      CHECK (visibility IN ('organization', 'department'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_visibility_check') THEN
    ALTER TABLE documents ADD CONSTRAINT documents_visibility_check
      CHECK (visibility IN ('organization', 'department'));
  END IF;
END $$;

COMMENT ON COLUMN agents.visibility IS
  'organization = 기관 전 직원, department = 지정 부서와 그 하위 부서만';
COMMENT ON COLUMN documents.visibility IS
  'organization = 기관 전 직원, department = 지정 부서와 그 하위 부서만';


-- ── 2. organization_id 자동 채움 트리거 ──────────────────────
CREATE OR REPLACE FUNCTION fill_organization_id_from_department()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.organization_id IS NULL AND NEW.department_id IS NOT NULL THEN
    SELECT d.organization_id INTO NEW.organization_id
      FROM departments d WHERE d.id = NEW.department_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agents_fill_org ON agents;
CREATE TRIGGER trg_agents_fill_org
  BEFORE INSERT OR UPDATE OF department_id ON agents
  FOR EACH ROW EXECUTE FUNCTION fill_organization_id_from_department();

DROP TRIGGER IF EXISTS trg_documents_fill_org ON documents;
CREATE TRIGGER trg_documents_fill_org
  BEFORE INSERT OR UPDATE OF department_id ON documents
  FOR EACH ROW EXECUTE FUNCTION fill_organization_id_from_department();


-- ── 3. 기존 데이터 백필 ──────────────────────────────────────
UPDATE agents a
SET organization_id = d.organization_id
FROM departments d
WHERE d.id = a.department_id AND a.organization_id IS NULL;

UPDATE documents doc
SET organization_id = d.organization_id
FROM departments d
WHERE d.id = doc.department_id AND doc.organization_id IS NULL;

-- 기존 자료는 지금까지 '해당 부서에서만' 보이고 있었다.
-- 기본값(organization)을 그대로 적용하면 부서 전용이던 자료가 갑자기 기관
-- 전체에 공개된다. 민감 자료가 있을 수 있으므로 기존 행은 현재 동작을 유지한다.
-- 새로 만드는 자료부터 기관 전체 공개가 기본이 된다.
UPDATE agents    SET visibility = 'department' WHERE created_at < now();
UPDATE documents SET visibility = 'department' WHERE created_at < now();

-- 나만의 비서는 소유자 기준으로 접근이 결정되므로 공개 범위와 무관하다.
-- 혼동을 줄이기 위해 department로 고정해 둔다.
UPDATE agents SET visibility = 'department' WHERE is_personal = true;


-- ── 4. 조회 인덱스 ───────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_agents_org_visibility ON agents(organization_id, visibility);
CREATE INDEX IF NOT EXISTS idx_documents_org_visibility ON documents(organization_id, visibility);


-- ── 5. 부서 전체 문서 검색에 공개 범위 반영 ──────────────────
-- /api/qna가 쓰는 RPC. 기관 전체 공개 문서 + 내 부서 계통의 부서 제한 문서.
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
declare
  v_org_id uuid;
begin
  select organization_id into v_org_id from departments where id = p_department_id;

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
    (
      -- 기관 전체 공개
      (d.visibility = 'organization' and d.organization_id = v_org_id)
      or
      -- 부서 제한: 내 부서와 그 상위 부서에 걸린 것만
      (d.visibility = 'department'
        and d.department_id in (select id from department_ancestors(p_department_id)))
    )
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


-- ── 6. 확인 ──────────────────────────────────────────────────
SELECT 'agents' AS t, visibility, count(*) FROM agents GROUP BY visibility
UNION ALL
SELECT 'documents', visibility, count(*) FROM documents GROUP BY visibility;
