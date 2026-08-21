-- 0024: 부서별·사용자별 월 금액 한도
--
-- 지금까지 한도는 **기관 하나뿐**이었다(monthly_token_limit, annual_budget_krw).
-- 그래서 한 사람이 한 달 치 예산을 혼자 태워도 막을 방법이 없었다.
--
-- 왜 금액인가:
--   토큰 기준은 모델이 늘면 "토큰 100만"의 뜻이 모델마다 달라진다. 게다가
--   공공기관은 부서별로 **금액**을 배정받는다. 0017이 기관 단위에서 이미
--   금액으로 옮겼으므로 아래 층도 같은 단위를 쓴다.
--
-- 왜 세 층인가:
--   부서 한도만 두면 부서 안에서 한 사람이 다 쓸 수 있고, 사용자 한도만
--   두면 부서 전체 합이 예산을 넘는다. 둘 다 필요하다.
--   사용자별 값은 부서 기본값을 덮어쓰는 예외다 — 담당 업무가 무거운
--   직원 한둘에게 더 주는 용도이지, 전원에게 일일이 적으라는 뜻이 아니다.

-- ── 부서 ──────────────────────────────────────────────────────
ALTER TABLE departments
  -- 부서 전체가 한 달에 쓸 수 있는 금액(원). NULL이면 제한 없음.
  ADD COLUMN IF NOT EXISTS monthly_budget_krw numeric(14,2),
  -- 이 부서 소속 직원 1인이 한 달에 쓸 수 있는 기본 금액(원). NULL이면 제한 없음.
  ADD COLUMN IF NOT EXISTS user_monthly_budget_krw numeric(14,2);

COMMENT ON COLUMN departments.monthly_budget_krw IS
  '부서 월 한도(원). NULL이면 제한 없음. 판정은 src/lib/usage-limit.ts';
COMMENT ON COLUMN departments.user_monthly_budget_krw IS
  '이 부서 직원 1인당 월 기본 한도(원). users.monthly_budget_krw가 있으면 그쪽이 우선.';

-- ── 사용자 ────────────────────────────────────────────────────
ALTER TABLE users
  -- 개인별 재정의. NULL이면 부서 기본값을 따른다.
  ADD COLUMN IF NOT EXISTS monthly_budget_krw numeric(14,2);

COMMENT ON COLUMN users.monthly_budget_krw IS
  '개인 월 한도(원). NULL이면 소속 부서의 user_monthly_budget_krw를 따른다.';

-- ── 사용액 집계 ───────────────────────────────────────────────
--
-- 0017의 organization_spend_krw와 같은 규약을 따른다:
--   details->>'cost_krw'를 합산하고, **그 키가 없는 옛 로그는 제외**한다.
--   추정치로 서비스를 차단하지 않겠다는 뜻이다.
--
-- 매 요청마다 로그를 앱으로 끌어와 더하면 월 수천 건만 되어도 무겁다.
-- 합산은 DB에서 끝낸다.

CREATE OR REPLACE FUNCTION department_spend_krw(
  p_department_id uuid,
  p_from timestamptz,
  p_to   timestamptz
)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(SUM((details->>'cost_krw')::numeric), 0)
  FROM usage_logs
  WHERE department_id = p_department_id
    AND created_at >= p_from
    AND created_at <= p_to
    AND details ? 'cost_krw';
$$;

COMMENT ON FUNCTION department_spend_krw(uuid, timestamptz, timestamptz) IS
  '부서의 기간 내 누적 사용액(원). 부서 월 한도 판정에 쓴다.';

CREATE OR REPLACE FUNCTION user_spend_krw(
  p_user_id uuid,
  p_from timestamptz,
  p_to   timestamptz
)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(SUM((details->>'cost_krw')::numeric), 0)
  FROM usage_logs
  WHERE user_id = p_user_id
    AND created_at >= p_from
    AND created_at <= p_to
    AND details ? 'cost_krw';
$$;

COMMENT ON FUNCTION user_spend_krw(uuid, timestamptz, timestamptz) IS
  '직원 한 명의 기간 내 누적 사용액(원). 개인 월 한도 판정에 쓴다.';

-- 위 두 함수가 매 대화마다 돈다. 인덱스가 없으면 usage_logs 전체를 훑는다.
CREATE INDEX IF NOT EXISTS idx_usage_logs_dept_created
  ON usage_logs (department_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_logs_user_created
  ON usage_logs (user_id, created_at DESC);


-- ── 확인 ──────────────────────────────────────────────────────
SELECT
  count(*)                                                  AS 부서수,
  count(*) FILTER (WHERE monthly_budget_krw IS NOT NULL)     AS 부서한도설정,
  count(*) FILTER (WHERE user_monthly_budget_krw IS NOT NULL) AS 인당기본설정
FROM departments;
