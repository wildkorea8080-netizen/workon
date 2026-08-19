-- =============================================================
-- 0018_backfill_usage_org.sql
-- usage_logs.organization_id 과거 행 백필
--
-- 배경:
--   0012가 넣은 trg_usage_logs_fill_org는 BEFORE INSERT 트리거다.
--   트리거가 생기기 전에 쌓인 행은 organization_id가 NULL로 남는다.
--
--   이 컬럼은 슈퍼관리자 사용량·매출 집계와 연간 정액 계약의 예산 소진
--   판정(organization_spend_krw)이 모두 기준으로 삼는다. NULL인 행은
--   어느 기관에도 잡히지 않아 사용량이 실제보다 적게 보인다.
--   공공기관 정산에서 누락은 과소청구로 이어지므로 메워 둔다.
--
--   department_id로부터 유도하므로 추측이 없다. 부서를 특정할 수 없는
--   행(department_id IS NULL)은 손대지 않는다 — 임의의 기관에 귀속시키면
--   그 기관 예산을 남의 사용량으로 깎게 된다.
-- =============================================================

UPDATE usage_logs u
   SET organization_id = d.organization_id
  FROM departments d
 WHERE u.department_id = d.id
   AND u.organization_id IS NULL;


-- ── 확인 ─────────────────────────────────────────────────────
-- 남은 건은 department_id 자체가 없어 귀속시킬 수 없는 행이다.
SELECT
  count(*) FILTER (WHERE organization_id IS NULL)                            AS 미연결,
  count(*) FILTER (WHERE organization_id IS NULL AND department_id IS NULL)  AS 부서없어귀속불가
FROM usage_logs;
