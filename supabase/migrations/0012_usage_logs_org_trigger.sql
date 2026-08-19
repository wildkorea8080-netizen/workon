-- =============================================================
-- 0012_usage_logs_org_trigger.sql
-- usage_logs.organization_id 자동 채움 트리거 + 재백필
--
-- 배경:
--   0006에서 usage_logs.organization_id 컬럼과 1회성 백필을 추가했지만
--   애플리케이션 코드(7개 insert 지점) 어디에서도 이 컬럼을 쓰지 않아
--   0006 이후 적재된 모든 사용 로그의 organization_id가 NULL이었다.
--   그 결과 슈퍼관리자 사용량 집계·한도 알림·과금 통계가 전부 0으로 나왔다.
--
--   각 insert 지점을 개별 수정하는 대신 트리거로 보장한다.
--   신규 insert 지점이 추가돼도 누락되지 않는다.
-- =============================================================

-- ── 1. department_id로부터 organization_id를 유도하는 트리거 ──
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

DROP TRIGGER IF EXISTS trg_usage_logs_fill_org ON usage_logs;

CREATE TRIGGER trg_usage_logs_fill_org
  BEFORE INSERT ON usage_logs
  FOR EACH ROW
  EXECUTE FUNCTION fill_usage_logs_organization_id();


-- ── 2. 0006 이후 쌓인 NULL 행 재백필 ─────────────────────────
UPDATE usage_logs ul
SET organization_id = d.organization_id
FROM departments d
WHERE d.id = ul.department_id
  AND ul.organization_id IS NULL
  AND d.organization_id IS NOT NULL;


-- ── 3. 확인 ──────────────────────────────────────────────────
-- 남은 NULL은 department가 organization에 연결되지 않은 경우뿐이어야 한다.
SELECT
  count(*) FILTER (WHERE organization_id IS NULL) AS still_null,
  count(*)                                        AS total
FROM usage_logs;
