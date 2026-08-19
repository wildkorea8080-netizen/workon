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
