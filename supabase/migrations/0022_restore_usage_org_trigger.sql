-- =============================================================
-- 0022_restore_usage_org_trigger.sql
-- usage_logs 기관 자동 채움 트리거 복구 + 재백필
--
-- 배경:
--   0012가 넣었어야 할 trg_usage_logs_fill_org가 실제 DB에 없었다.
--   컬럼(usage_logs.organization_id)은 있는데 트리거만 빠져 있었다 —
--   0012 파일 전체가 아니라 일부만 실행됐던 것으로 보인다.
--
--   증상이 조용하다. 대화는 정상이고 오류도 안 난다. 다만 새로 쌓이는
--   로그가 전부 organization_id NULL이 되어,
--     · 슈퍼관리자 사용량·매출 통계에서 빠지고
--     · 연간 정액 계약의 예산 소진 판정(organization_spend_krw)에서 빠진다
--   즉 쓴 만큼 청구되지 않고 한도도 걸리지 않는다.
--
--   실측(2026-08-19): 2026-08-18에 쌓인 8건이 전부 NULL이었다. 그 부서에는
--   organization_id가 멀쩡히 있었으므로 데이터 문제가 아니라 트리거 부재였다.
--
--   npm run db:check가 컬럼만 확인하고 트리거는 못 봤다(PostgREST로는
--   pg_trigger를 볼 수 없다). 이 마이그레이션 끝의 확인 쿼리로 대신한다.
-- =============================================================

-- ── 1. 함수 (0012와 동일. CREATE OR REPLACE라 재실행 안전) ──
CREATE OR REPLACE FUNCTION fill_usage_logs_organization_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- 호출자가 명시적으로 넣어준 값이 있으면 존중한다
  IF NEW.organization_id IS NULL AND NEW.department_id IS NOT NULL THEN
    SELECT d.organization_id
      INTO NEW.organization_id
      FROM departments d
     WHERE d.id = NEW.department_id;
  END IF;

  RETURN NEW;
END;
$$;


-- ── 2. 트리거 ────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_usage_logs_fill_org ON usage_logs;

CREATE TRIGGER trg_usage_logs_fill_org
  BEFORE INSERT ON usage_logs
  FOR EACH ROW
  EXECUTE FUNCTION fill_usage_logs_organization_id();


-- ── 3. 트리거가 없던 동안 쌓인 로그 재백필 ───────────────────
-- 0018과 같은 구문이다. department_id로부터 유도하므로 추측이 없다.
-- 부서를 특정할 수 없는 행(department_id IS NULL)은 손대지 않는다 —
-- 임의의 기관에 귀속시키면 그 기관 예산을 남의 사용량으로 깎게 된다.
UPDATE usage_logs u
   SET organization_id = d.organization_id
  FROM departments d
 WHERE u.department_id = d.id
   AND u.organization_id IS NULL;


-- ── 확인 ─────────────────────────────────────────────────────
-- 트리거가 실제로 붙었는지 본다. 이게 이 마이그레이션의 요점이다.
SELECT
  (SELECT count(*) FROM pg_trigger
    WHERE tgname = 'trg_usage_logs_fill_org' AND NOT tgisinternal)  AS 트리거,
  (SELECT count(*) FROM usage_logs WHERE organization_id IS NULL)   AS 미연결,
  (SELECT count(*) FROM usage_logs
    WHERE organization_id IS NULL AND department_id IS NULL)        AS 부서없어귀속불가;
