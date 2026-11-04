-- 0052: 개인 월 한도 알림 메일 (src/lib/budget-alerts.ts)
--
-- 0024의 개인 월 한도(users.monthly_budget_krw, 없으면 departments.user_monthly_budget_krw)는 넘으면 그 직원의 요청을 막는다.
-- 그런데 알림 메일(0045)은 기관·부서에만 있어 직원은 막힌 뒤에야 안다. 하루 한 번 예산 알림 작업이 직원 본인에게도
-- 80·90·100% 메일을 보내게 한다. 같은 사람·같은 달·같은 기준은 한 번만(0045의 유일 키를 그대로 쓴다).
--
-- 추가만(기존 행은 그대로). 여러 번 적용해도 안전. 코드 배포 전에 적용 — 없으면 개인 알림만 건너뛰고(집계 함수가 없어
-- 기관마다 경고 한 줄) 기관·부서 알림은 그대로 돈다.

-- ── 알림 기록이 직원 대상도 받게 ─────────────────────────────
ALTER TABLE public.budget_alerts DROP CONSTRAINT IF EXISTS budget_alerts_subject_check;
ALTER TABLE public.budget_alerts ADD CONSTRAINT budget_alerts_subject_check
  CHECK (subject ~ '^(org|dept:[0-9a-f-]{36}|user:[0-9a-f-]{36})$');
ALTER TABLE public.budget_alerts DROP CONSTRAINT IF EXISTS budget_alerts_kind_check;
ALTER TABLE public.budget_alerts ADD CONSTRAINT budget_alerts_kind_check
  CHECK (kind IN ('annual_budget', 'monthly_tokens', 'department_monthly', 'user_monthly'));

-- ── 기관 안 한도가 있는 직원의 한도·사용액을 한 번에 ─────────
--
-- 판정 규칙은 usage-limit.ts의 checkMonthlyBudget과 같다:
--   한도 = COALESCE(개인 값, 부서 기본값), 0 이하·NULL은 한도 없음.
--   사용액 = user_spend_krw와 같은 식(details->>'cost_krw' 합, 그 키가 없는 옛 로그는 제외, 부서를 옮겨도 사람 기준).
-- 직원마다 앱에서 함수를 부르면 기관당 수백 번이 되므로 DB에서 한 번에 낸다. 비활성·탈퇴·슈퍼관리자는 뺀다.
CREATE OR REPLACE FUNCTION public.organization_user_budget_usage(
  p_organization_id uuid,
  p_from timestamptz,
  p_to   timestamptz
)
RETURNS TABLE (user_id uuid, limit_krw numeric, spent_krw numeric)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH limited AS (
    SELECT u.id, COALESCE(u.monthly_budget_krw, d.user_monthly_budget_krw) AS limit_krw
    FROM users u
    JOIN departments d ON d.id = u.department_id
    WHERE d.organization_id = p_organization_id
      AND u.is_active IS TRUE
      AND u.deleted_at IS NULL
      AND COALESCE(u.is_super_admin, false) = false
      AND COALESCE(u.monthly_budget_krw, d.user_monthly_budget_krw) > 0
  )
  SELECT l.id,
         l.limit_krw,
         COALESCE((
           SELECT SUM((ul.details->>'cost_krw')::numeric)
           FROM usage_logs ul
           WHERE ul.user_id = l.id
             AND ul.created_at >= p_from
             AND ul.created_at <= p_to
             AND ul.details ? 'cost_krw'
         ), 0)
  FROM limited l;
$$;

COMMENT ON FUNCTION public.organization_user_budget_usage(uuid, timestamptz, timestamptz) IS
  '기관 안 개인 월 한도가 있는 활성 직원의 한도·기간 사용액(원). 개인 한도 알림 메일(budget-alerts.ts)이 쓴다.';

REVOKE ALL ON FUNCTION public.organization_user_budget_usage(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.organization_user_budget_usage(uuid, timestamptz, timestamptz) TO service_role;

NOTIFY pgrst, 'reload schema';
