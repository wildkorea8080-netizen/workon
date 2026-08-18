-- =============================================================
-- 마이그레이션 0013 ~ 0017 일괄 적용
--
-- 이 파일 하나만 Supabase SQL Editor에 붙여넣고 Run 하세요.
-- 개별 파일을 순서대로 여는 과정에서 누락되는 것을 막기 위해 합쳐둔 것이며,
-- 내용은 각 마이그레이션 파일과 동일합니다.
--
-- 스키마 변경은 모두 IF NOT EXISTS / CREATE OR REPLACE 기반이라 여러 번 실행해도
-- 안전합니다 (컬럼 9건, 인덱스 6건, 함수 4건 모두 확인).
--
-- ⚠️ 단 하나 예외: 0016의 공개 범위 백필입니다.
--    UPDATE agents/documents SET visibility='department' WHERE created_at < now()
--    최초 1회는 "기존 자료를 갑자기 전체 공개하지 않기 위한" 안전장치지만,
--    관리자가 일부를 '기관 전체'로 바꾼 뒤 이 파일을 다시 실행하면 그 설정이
--    전부 'department'로 되돌아갑니다.
--    → 최초 적용에만 이 파일을 쓰고, 이후에는 개별 마이그레이션을 쓰세요.
--
-- 실행 후 확인:
--   터미널에서  npm run db:check
--   또는 supabase/verify_migrations.sql 의 점검 쿼리
-- =============================================================



-- ==========================================================
-- ▼▼▼  0013_agent_connectors.sql
-- ==========================================================

-- =============================================================
-- 0013_agent_connectors.sql
-- 에이전트별 외부 도구(커넥터) 사용 설정
--
-- 배경:
--   툴 실행 루프 도입 시 모든 에이전트에 모든 도구가 노출됐다.
--   음슴체 변환 비서에까지 국가법령정보 도구가 붙어 매 요청마다 툴 정의
--   토큰이 붙고 오호출 가능성도 생긴다.
--
--   커넥터 id 배열로 관리한다 (예: {'law'}). 툴 단위가 아니라 커넥터 단위인
--   이유는 관리자가 "국가법령정보를 쓸지"를 결정하지 "law_search를 쓸지"를
--   결정하지는 않기 때문이다.
--
--   기본값은 빈 배열 = 도구 사용 안 함. 관리자가 명시적으로 켜야 한다.
-- =============================================================

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS enabled_connectors text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN agents.enabled_connectors IS
  '이 에이전트가 사용할 커넥터 id 목록. 빈 배열이면 외부 도구를 쓰지 않는다.';

-- 조회는 항상 에이전트 단건이라 인덱스는 두지 않는다.

-- 확인
SELECT
  count(*)                                                   AS total_agents,
  count(*) FILTER (WHERE cardinality(enabled_connectors) > 0) AS with_connectors
FROM agents;


-- ==========================================================
-- ▼▼▼  0014_department_hierarchy.sql
-- ==========================================================

-- =============================================================
-- 0014_department_hierarchy.sql
-- 부서 계층 구조 + 기관 단위 격리 강화
--
-- 배경 1 (보안):
--   bulk-register가 부서를 이름만으로 조회했다.
--     .from('departments').select('id').eq('name', deptName)
--   공공기관 부서명은 기관마다 중복된다 — '총무과', '기획예산과', '감사담당관'.
--   그래서 B기관 관리자가 CSV로 '총무과'를 등록하면 A기관의 '총무과'가 잡혀
--   B기관 직원이 A기관 부서에 배정되고, A기관의 문서·비서·대화에 접근할 수
--   있었다. 애플리케이션 코드와 함께 스키마에서도 막는다.
--
-- 배경 2 (계층):
--   CSV 양식은 '상위부서명'을 받는데 저장할 컬럼이 없어 값이 버려졌다.
--   공공기관은 기관 > 국/본부 > 과 > 팀처럼 위계가 깊어, 평면 구조로는
--   "우리 과만 보는 문서"를 만들 수 없다. 모든 부서가 쓰려면 필수다.
-- =============================================================

-- ── 1. organization_id 백필 ──────────────────────────────────
-- 0006이 한 번 연결했지만 이후 생성된 부서는 NULL로 남아 있다
-- (bulk-register가 organization_id 없이 insert 했음).
DO $$
DECLARE
  v_org_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM departments WHERE organization_id IS NULL) THEN
    SELECT id INTO v_org_id FROM organizations ORDER BY created_at LIMIT 1;

    IF v_org_id IS NULL THEN
      INSERT INTO organizations (name, type, status, plan)
      VALUES ('기본 기관', '공공기관', 'active', 'basic')
      RETURNING id INTO v_org_id;
    END IF;

    UPDATE departments SET organization_id = v_org_id WHERE organization_id IS NULL;
    RAISE NOTICE '기관 미연결 부서를 %로 연결했습니다.', v_org_id;
  END IF;
END $$;

ALTER TABLE departments
  ALTER COLUMN organization_id SET NOT NULL;


-- ── 2. 상위 부서 ─────────────────────────────────────────────
ALTER TABLE departments
  ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES departments(id) ON DELETE SET NULL;

COMMENT ON COLUMN departments.parent_id IS
  '상위 부서. NULL이면 기관 직속 최상위 부서.';

CREATE INDEX IF NOT EXISTS idx_departments_parent ON departments(parent_id);


-- ── 3. 유일성 기준을 기관 단위로 ─────────────────────────────
-- slug가 전역 UNIQUE라 기관 간 동명 부서('총무과')를 아예 만들 수 없었다.
DROP INDEX IF EXISTS departments_slug_idx;

CREATE UNIQUE INDEX IF NOT EXISTS departments_org_slug_idx
  ON departments(organization_id, slug);

-- 같은 기관 안에서 부서명도 유일해야 이름 기반 조회가 안전하다
CREATE UNIQUE INDEX IF NOT EXISTS departments_org_name_idx
  ON departments(organization_id, name);


-- ── 4. 하위 부서 조회 헬퍼 ───────────────────────────────────
-- 상위 부서에 공유한 자료를 하위 부서가 함께 보는 구조에 쓴다.
-- 자기 자신을 포함한 모든 후손을 반환한다.
CREATE OR REPLACE FUNCTION department_descendants(p_department_id uuid)
RETURNS TABLE (id uuid)
LANGUAGE sql
STABLE
AS $$
  WITH RECURSIVE tree AS (
    SELECT d.id FROM departments d WHERE d.id = p_department_id
    UNION ALL
    SELECT d.id FROM departments d JOIN tree t ON d.parent_id = t.id
  )
  SELECT id FROM tree;
$$;


-- ── 5. 확인 ──────────────────────────────────────────────────
SELECT
  count(*)                                        AS total,
  count(*) FILTER (WHERE parent_id IS NOT NULL)   AS with_parent,
  count(DISTINCT organization_id)                 AS orgs
FROM departments;


-- ==========================================================
-- ▼▼▼  0015_department_sharing.sql
-- ==========================================================

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


-- ==========================================================
-- ▼▼▼  0016_visibility.sql
-- ==========================================================

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


-- ==========================================================
-- ▼▼▼  0017_annual_contract.sql
-- ==========================================================

-- =============================================================
-- 0017_annual_contract.sql
-- 연간 정액 계약 + 금액 기준 한도
--
-- 배경 1 (공공 예산):
--   공공기관 예산은 전년도에 확정 금액으로 편성된다. "쓴 만큼 낸다"는
--   종량제는 예산 편성과 궁합이 나쁘다. 기관은 "연간 5,000만원" 같은
--   확정 계약을 요구한다.
--
-- 배경 2 (토큰 한도의 한계):
--   기존 한도는 monthly_token_limit, 즉 토큰 수 기준이다. 모델이 하나일 때는
--   문제가 없지만 단가가 다른 모델을 추가하면 "토큰 100만"의 의미가 모델마다
--   달라진다. 0016까지 usage_logs.details에 cost_krw를 쌓아왔으므로 이제
--   금액 기준으로 판정할 수 있다.
--
--   두 방식을 함께 둔다. 기존 계약은 그대로 토큰 기준으로 돌아가고,
--   연간 정액 계약만 금액 기준으로 판정한다.
-- =============================================================

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS billing_type text NOT NULL DEFAULT 'pay_as_you_go',
  -- 'pay_as_you_go' = 종량제(기존), 'annual_fixed' = 연간 정액
  ADD COLUMN IF NOT EXISTS annual_budget_krw numeric(14,2),
  -- 연간 계약 금액(원). billing_type='annual_fixed'일 때만 의미가 있다.
  ADD COLUMN IF NOT EXISTS budget_alert_percent int NOT NULL DEFAULT 80;
  -- 소진율이 이 값을 넘으면 경고. 차단은 100% 시점.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contracts_billing_type_check') THEN
    ALTER TABLE contracts ADD CONSTRAINT contracts_billing_type_check
      CHECK (billing_type IN ('pay_as_you_go', 'annual_fixed'));
  END IF;
END $$;

COMMENT ON COLUMN contracts.billing_type IS
  'pay_as_you_go = 사용량만큼 후불(월 토큰 한도로 통제), annual_fixed = 연간 확정 금액(누적 비용으로 통제)';
COMMENT ON COLUMN contracts.annual_budget_krw IS
  '연간 계약 금액(원). 계약 기간 누적 사용액이 이 값에 도달하면 차단한다.';


-- ── 계약 기간 누적 사용액 조회 ───────────────────────────────
-- usage_logs.details에 기록된 cost_krw를 합산한다.
-- cost_krw가 없는 과거 로그(2026-08 이전)는 0으로 취급한다 —
-- 연간 정액 계약은 이 기능 도입 이후에만 맺히므로 문제되지 않는다.
CREATE OR REPLACE FUNCTION organization_spend_krw(
  p_organization_id uuid,
  p_from timestamptz,
  p_to   timestamptz
)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(SUM((details->>'cost_krw')::numeric), 0)
  FROM usage_logs
  WHERE organization_id = p_organization_id
    AND created_at >= p_from
    AND created_at <= p_to
    AND details ? 'cost_krw';
$$;

COMMENT ON FUNCTION organization_spend_krw(uuid, timestamptz, timestamptz) IS
  '기관의 기간 내 누적 사용액(원). 연간 정액 계약의 예산 소진 판정에 쓴다.';


-- ── 조회 인덱스 ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_contracts_org_status ON contracts(organization_id, status);


-- ── 확인 ─────────────────────────────────────────────────────
SELECT
  billing_type AS 과금형태,
  count(*)     AS 계약수,
  count(*) FILTER (WHERE annual_budget_krw IS NOT NULL) AS 예산설정됨
FROM contracts
GROUP BY billing_type;
