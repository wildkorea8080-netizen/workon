-- =============================================================
-- 마이그레이션 0012~0017 적용 상태 점검
--
-- Supabase SQL Editor에 그대로 붙여넣고 Run 하세요.
-- 스키마를 바꾸지 않는 읽기 전용 쿼리라 몇 번 실행해도 안전합니다.
--
-- '상태' 열이 전부 OK여야 정상입니다.
-- '없음'이 있으면 해당 마이그레이션 파일을 **전체** 복사해 실행하세요.
-- (파일 끝의 확인 쿼리만 실행하면 컬럼이 없다고 나옵니다)
-- =============================================================

WITH checks AS (
  -- ── 0012: usage_logs 기관 집계 ──────────────────────────────
  SELECT 1 AS ord, '0012' AS 마이그레이션, 'usage_logs.organization_id 컬럼' AS 항목,
         CASE WHEN EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'usage_logs' AND column_name = 'organization_id'
         ) THEN 'OK' ELSE '없음' END AS 상태
  UNION ALL
  SELECT 2, '0012', '자동 채움 트리거',
         CASE WHEN EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_usage_logs_fill_org')
           THEN 'OK' ELSE '없음' END

  -- ── 0013: 에이전트별 커넥터 ─────────────────────────────────
  UNION ALL
  SELECT 3, '0013', 'agents.enabled_connectors 컬럼',
         CASE WHEN EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'agents' AND column_name = 'enabled_connectors'
         ) THEN 'OK' ELSE '없음' END

  -- ── 0014: 부서 계층 ─────────────────────────────────────────
  UNION ALL
  SELECT 4, '0014', 'departments.parent_id 컬럼',
         CASE WHEN EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'departments' AND column_name = 'parent_id'
         ) THEN 'OK' ELSE '없음' END
  UNION ALL
  SELECT 5, '0014', 'departments.organization_id NOT NULL',
         CASE WHEN EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'departments' AND column_name = 'organization_id'
             AND is_nullable = 'NO'
         ) THEN 'OK' ELSE '아직 NULL 허용' END
  UNION ALL
  SELECT 6, '0014', '기관 단위 유일 인덱스 (org, name)',
         CASE WHEN EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'departments_org_name_idx')
           THEN 'OK' ELSE '없음' END
  UNION ALL
  SELECT 7, '0014', 'department_descendants 함수',
         CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'department_descendants')
           THEN 'OK' ELSE '없음' END

  -- ── 0015: 계층 공유 ─────────────────────────────────────────
  UNION ALL
  SELECT 8, '0015', 'department_ancestors 함수',
         CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'department_ancestors')
           THEN 'OK' ELSE '없음' END

  -- ── 0016: 공개 범위 ─────────────────────────────────────────
  UNION ALL
  SELECT 9, '0016', 'agents.visibility 컬럼',
         CASE WHEN EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'agents' AND column_name = 'visibility'
         ) THEN 'OK' ELSE '없음' END
  UNION ALL
  SELECT 10, '0016', 'documents.visibility 컬럼',
         CASE WHEN EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'documents' AND column_name = 'visibility'
         ) THEN 'OK' ELSE '없음' END
  UNION ALL
  SELECT 11, '0016', 'agents.organization_id 컬럼',
         CASE WHEN EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'agents' AND column_name = 'organization_id'
         ) THEN 'OK' ELSE '없음' END
  UNION ALL
  SELECT 12, '0016', 'documents.organization_id 컬럼',
         CASE WHEN EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'documents' AND column_name = 'organization_id'
         ) THEN 'OK' ELSE '없음' END
  UNION ALL
  SELECT 13, '0016', 'agents 기관 자동 채움 트리거',
         CASE WHEN EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_agents_fill_org')
           THEN 'OK' ELSE '없음' END
  UNION ALL
  SELECT 14, '0016', 'documents 기관 자동 채움 트리거',
         CASE WHEN EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_documents_fill_org')
           THEN 'OK' ELSE '없음' END

  -- ── 0017: 연간 정액 계약 ────────────────────────────────────
  UNION ALL
  SELECT 15, '0017', 'contracts.billing_type 컬럼',
         CASE WHEN EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'contracts' AND column_name = 'billing_type'
         ) THEN 'OK' ELSE '없음' END
  UNION ALL
  SELECT 16, '0017', 'contracts.annual_budget_krw 컬럼',
         CASE WHEN EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'contracts' AND column_name = 'annual_budget_krw'
         ) THEN 'OK' ELSE '없음' END
  UNION ALL
  SELECT 17, '0017', 'contracts.budget_alert_percent 컬럼',
         CASE WHEN EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'contracts' AND column_name = 'budget_alert_percent'
         ) THEN 'OK' ELSE '없음' END
  UNION ALL
  SELECT 18, '0017', 'organization_spend_krw 함수',
         CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'organization_spend_krw')
           THEN 'OK' ELSE '없음' END
)
SELECT 마이그레이션, 항목, 상태 FROM checks ORDER BY ord;


-- =============================================================
-- 데이터 상태 (위 점검이 전부 OK인 뒤에 실행하세요)
-- =============================================================

-- 1) 공개 범위 분포
--    0016 직후에는 기존 자료가 전부 'department'여야 정상입니다.
--    (기본값을 그대로 적용하면 부서 전용이던 자료가 갑자기 전체 공개됨)
SELECT 'agents'    AS 테이블, visibility AS 공개범위, count(*) AS 건수 FROM agents    GROUP BY visibility
UNION ALL
SELECT 'documents', visibility, count(*) FROM documents GROUP BY visibility
ORDER BY 테이블, 공개범위;


-- 2) 기관 연결이 빠진 행 — 전부 0이어야 정상
SELECT '부서'   AS 대상, count(*) AS 기관미연결 FROM departments WHERE organization_id IS NULL
UNION ALL
SELECT '비서',   count(*) FROM agents    WHERE organization_id IS NULL
UNION ALL
SELECT '문서',   count(*) FROM documents WHERE organization_id IS NULL
UNION ALL
SELECT '사용로그', count(*) FROM usage_logs WHERE organization_id IS NULL;


-- 3) 부서 계층 — 각 부서에서 보이는 상위 단계 수 (자기 자신 포함이라 최소 1)
SELECT
  d.name                                              AS 부서,
  (SELECT count(*) FROM department_ancestors(d.id))   AS 볼수있는단계,
  (SELECT count(*) FROM department_descendants(d.id)) AS 공유시대상부서
FROM departments d
ORDER BY 볼수있는단계 DESC, d.name
LIMIT 20;


-- 4) 계약 형태 분포
--    0017 직후에는 기존 계약이 전부 'pay_as_you_go'여야 정상입니다.
--    (연간 정액은 새로 맺는 계약부터 적용)
SELECT
  billing_type AS 과금형태,
  status       AS 상태,
  count(*)     AS 계약수,
  count(*) FILTER (WHERE annual_budget_krw IS NOT NULL) AS 예산설정됨
FROM contracts
GROUP BY billing_type, status
ORDER BY 과금형태, 상태;


-- 5) 연간 정액 계약의 예산 소진 현황
--    연간 정액 계약이 없으면 결과가 비어 있는 것이 정상입니다.
SELECT
  o.name                                    AS 기관,
  c.annual_budget_krw                       AS 계약금액,
  organization_spend_krw(
    c.organization_id,
    c.started_at,
    COALESCE(c.expires_at, now())
  )                                         AS 누적사용액,
  ROUND(
    organization_spend_krw(
      c.organization_id, c.started_at, COALESCE(c.expires_at, now())
    ) / NULLIF(c.annual_budget_krw, 0) * 100
  )                                         AS 소진율,
  c.budget_alert_percent                    AS 경고기준,
  c.expires_at                              AS 계약종료
FROM contracts c
JOIN organizations o ON o.id = c.organization_id
WHERE c.billing_type = 'annual_fixed'
  AND c.status = 'active'
ORDER BY 소진율 DESC NULLS LAST;
