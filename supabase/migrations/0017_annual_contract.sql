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
