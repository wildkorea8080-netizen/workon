-- =============================================================
-- 0014 백필 사전 확인 (읽기 전용 — 아무것도 바꾸지 않습니다)
--
-- 0014에는 기관이 연결되지 않은 부서를 "가장 오래된 기관"에 붙이는
-- 백필이 들어 있습니다. 기관이 하나뿐이면 정확하지만, 기관이 둘 이상이면
-- 엉뚱한 기관에 붙어 타 기관 자료에 접근할 수 있게 됩니다.
--
-- Supabase SQL Editor는 마지막 statement의 결과만 보여주므로
-- 필요한 정보를 단일 쿼리로 합쳐 두었습니다. 그대로 붙여넣고 Run 하세요.
--
-- 읽는 법 — '판정' 열
--   진행 가능  → 그대로 apply_0013_to_0017.sql 실행
--   중단       → 그 행의 부서를 어느 기관에 붙일지 정한 뒤 수동 연결
--                (파일 맨 아래 UPDATE 예시 참고)
-- =============================================================

WITH stat AS (
  SELECT
    (SELECT count(*) FROM departments WHERE organization_id IS NULL) AS orphans,
    (SELECT count(*) FROM organizations)                             AS orgs,
    (SELECT name FROM organizations ORDER BY created_at LIMIT 1)     AS oldest_org
)
-- 미연결 부서가 있으면 한 행씩
SELECT
  CASE WHEN s.orgs <= 1
       THEN '진행 가능 — 기관이 하나뿐이라 붙을 곳이 정해짐'
       ELSE '중단 — 기관 ' || s.orgs || '개. 이 부서가 [' || s.oldest_org || ']에 붙습니다'
  END                                                          AS 판정,
  d.name                                                       AS 미연결부서,
  (SELECT count(*) FROM users u WHERE u.department_id = d.id)  AS 소속직원,
  d.created_at                                                 AS 부서생성,
  d.id                                                         AS 부서UUID
FROM stat s
JOIN departments d ON d.organization_id IS NULL

UNION ALL

-- 미연결 부서가 하나도 없으면 이 행 하나만 나옵니다
SELECT
  '진행 가능 — 미연결 부서 없음 (백필이 아예 안 돌아감)',
  '-', 0, NULL, NULL
FROM stat s
WHERE s.orphans = 0

ORDER BY 부서생성 NULLS FIRST;


-- =============================================================
-- '중단'이 나왔을 때: 아래로 기관 UUID를 확인하고 수동 연결하세요.
-- (별도 실행 — 위 쿼리와 같이 돌리면 결과가 가려집니다)
-- =============================================================
--
--   SELECT id, name, created_at FROM organizations ORDER BY created_at;
--
--   UPDATE departments
--      SET organization_id = '<기관 UUID>'
--    WHERE id = '<부서 UUID>';
--
-- 소속을 특정할 수 없는 부서는 추측해서 붙이지 말고 그대로 두거나
-- 삭제하세요. 잘못 붙이면 그 부서 직원이 타 기관 자료를 보게 됩니다.
