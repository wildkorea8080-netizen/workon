-- =============================================================
-- 0014 백필 사전 확인 (읽기 전용 — 아무것도 바꾸지 않습니다)
--
-- 0014에는 기관이 연결되지 않은 부서를 "가장 오래된 기관"에 붙이는
-- 백필이 들어 있습니다. 기관이 하나뿐이면 정확하지만, 기관이 둘 이상이면
-- 엉뚱한 기관에 붙어 타 기관 자료에 접근할 수 있게 됩니다.
--
-- 판정
--   미연결부서 = 0        → 백필이 아예 안 돌아감. 그대로 진행하세요.
--   미연결부서 > 0, 기관 = 1개 → 붙일 곳이 하나뿐이라 안전. 진행하세요.
--   미연결부서 > 0, 기관 = 2개 이상 → 중단. 아래 2번 결과를 보고
--                                     수동으로 연결한 뒤 진행하세요.
-- =============================================================

-- 1) 판정
SELECT
  (SELECT count(*) FROM departments WHERE organization_id IS NULL) AS 미연결부서,
  (SELECT count(*) FROM organizations)                             AS 기관수,
  CASE
    WHEN (SELECT count(*) FROM departments WHERE organization_id IS NULL) = 0
      THEN '진행 가능 — 백필 안 돌아감'
    WHEN (SELECT count(*) FROM organizations) <= 1
      THEN '진행 가능 — 기관이 하나뿐'
    ELSE '중단 — 아래 2번을 보고 수동 연결 후 진행'
  END AS 판정;

-- 2) 미연결 부서 목록 (위가 '중단'일 때만 의미 있음)
--    소속을 특정할 수 있으면 아래 3번으로 직접 연결하세요.
SELECT d.id, d.name AS 부서, d.slug, d.created_at,
       (SELECT count(*) FROM users u WHERE u.department_id = d.id) AS 소속직원
FROM departments d
WHERE d.organization_id IS NULL
ORDER BY d.created_at;

-- 3) 수동 연결 예시 (필요할 때 주석을 풀고 id를 채워 쓰세요)
-- UPDATE departments SET organization_id = '<기관 UUID>' WHERE id = '<부서 UUID>';

-- 4) 참고: 기관 목록
SELECT id, name AS 기관, status, created_at FROM organizations ORDER BY created_at;
