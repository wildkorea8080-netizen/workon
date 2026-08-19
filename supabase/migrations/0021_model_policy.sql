-- =============================================================
-- 0021_model_policy.sql
-- 기관별 허용 모델 정책
--
-- 배경:
--   지금은 모델이 claude-sonnet-4-6 하나로 고정돼 있습니다. 웍스AI는 40종을
--   고르게 하지만, 공공기관에서는 그게 그대로 장점이 되지 않습니다 —
--   "어떤 데이터가 어느 사업자에게 갔는지"를 보안성 검토에서 전부 소명해야
--   하기 때문입니다.
--
--   그래서 모델을 늘리기 **전에** 정책을 먼저 넣습니다. 순서가 반대면
--   정책이 붙기까지의 기간에 쌓인 사용 내역을 나중에 설명할 수 없습니다.
--
-- 기본값(NULL)은 "기본 모델만 허용"입니다. 빈 배열과 구분됩니다:
--   NULL      아직 정하지 않음 → 기본 모델만
--   ['a','b'] 이 둘만 허용
--   []        아무것도 허용 안 함 → 기본 모델로 되돌림(잠김 방지)
-- =============================================================

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS allowed_models text[];

COMMENT ON COLUMN organizations.allowed_models IS
  '이 기관에서 쓸 수 있는 모델 id 목록. NULL이면 기본 모델만 허용.';


-- ── 정책 변경 이력 ───────────────────────────────────────────
-- 어떤 모델을 언제부터 열었는지는 보안성 검토와 감사에서 실제로 묻는
-- 항목입니다. 현재 값만 보관하면 "그 시점에 무엇이 허용돼 있었는가"에
-- 답할 수 없습니다.
CREATE TABLE IF NOT EXISTS model_policy_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  changed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  before_models   text[],
  after_models    text[],
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_model_policy_logs_org
  ON model_policy_logs(organization_id, created_at DESC);

COMMENT ON TABLE model_policy_logs IS
  '기관별 허용 모델 변경 이력. 감사에서 "그 시점에 무엇이 허용돼 있었는가"를 묻는다.';


-- ── 확인 ─────────────────────────────────────────────────────
SELECT
  name                                              AS 기관,
  COALESCE(array_length(allowed_models, 1), 0)      AS 허용모델수,
  CASE WHEN allowed_models IS NULL THEN '미설정(기본 모델만)'
       ELSE array_to_string(allowed_models, ', ') END AS 허용목록
FROM organizations
ORDER BY created_at;
