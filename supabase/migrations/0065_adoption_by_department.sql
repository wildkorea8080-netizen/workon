-- 0065: 부서별 도입 현황 (src/lib/adoption-report.ts, /api/admin/adoption-report/departments)
--
-- 월별 도입 현황(0056)을 부서마다 나눠 센다 — 공공기관은 '부서별 활용 현황'을 따로 보고한다.
-- 부서마다 자기 부서의 기록만(하위 부서를 올려 더하지 않는다): 사람 수는 그 부서 소속 직원, 횟수·비용은 그 부서로 남은 기록.
-- 숫자만(직원·질문 원문·결과 글 없음). 추정치(절약한 시간)는 내지 않는다.
-- PostgREST 1,000행 상한을 피해 DB가 세고 값 하나(jsonb 배열)로 돌려준다.
-- 함수 추가만. 여러 번 적용해도 안전. 실행 권한 service_role만. 코드 배포 전에 적용 — 없으면 부서별 표만 실패한다.
CREATE OR REPLACE FUNCTION public.adoption_by_department(
  p_organization_id uuid,
  p_department_ids uuid[],
  p_from timestamptz,
  p_to   timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH depts AS (
    SELECT d.id, d.name
    FROM departments d
    WHERE d.id = ANY(p_department_ids) AND d.organization_id = p_organization_id
  ),
  scope_users AS (
    SELECT u.id, u.department_id, u.is_active
    FROM users u
    WHERE u.department_id IN (SELECT id FROM depts)
      AND u.deleted_at IS NULL
      AND COALESCE(u.is_super_admin, false) = false
  ),
  logs AS (
    SELECT l.user_id, l.department_id, l.action, l.created_at,
           CASE WHEN l.details->>'cost_krw' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (l.details->>'cost_krw')::numeric ELSE 0 END AS cost
    FROM usage_logs l
    WHERE l.department_id IN (SELECT id FROM depts)
      AND l.created_at >= p_from AND l.created_at < p_to
  ),
  user_days AS (
    -- 사람은 지금 소속 부서로 센다(한 사람은 한 부서에만 든다)
    SELECT su.department_id, l.user_id, count(DISTINCT (l.created_at AT TIME ZONE 'Asia/Seoul')::date) AS days
    FROM logs l JOIN scope_users su ON su.id = l.user_id
    GROUP BY su.department_id, l.user_id
  ),
  log_counts AS (
    SELECT department_id,
           count(*) FILTER (WHERE action = 'chat_message') AS chat_messages,
           count(*) FILTER (WHERE action IN ('document_generated', 'table_merged')) AS documents_generated,
           COALESCE(sum(cost), 0) AS cost_krw
    FROM logs GROUP BY department_id
  ),
  app_runs AS (
    SELECT c.department_id, count(*) AS n
    FROM conversations c JOIN agents a ON a.id = c.agent_id
    WHERE c.department_id IN (SELECT id FROM depts)
      AND c.created_at >= p_from AND c.created_at < p_to
      AND a.app_definition IS NOT NULL
    GROUP BY c.department_id
  ),
  tasks_done AS (
    SELECT t.department_id, count(*) AS n
    FROM work_tasks t
    WHERE t.organization_id = p_organization_id
      AND t.department_id IN (SELECT id FROM depts)
      AND t.approved_at >= p_from AND t.approved_at < p_to
    GROUP BY t.department_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'department_id', d.id,
    'name', d.name,
    'registered_users', (SELECT count(*) FROM scope_users su WHERE su.department_id = d.id AND su.is_active IS TRUE),
    'active_users', (SELECT count(*) FROM user_days ud WHERE ud.department_id = d.id),
    'regular_users', (SELECT count(*) FROM user_days ud WHERE ud.department_id = d.id AND ud.days >= 4),
    'chat_messages', COALESCE((SELECT chat_messages FROM log_counts lc WHERE lc.department_id = d.id), 0),
    'app_runs', COALESCE((SELECT n FROM app_runs r WHERE r.department_id = d.id), 0),
    'documents_generated', COALESCE((SELECT documents_generated FROM log_counts lc WHERE lc.department_id = d.id), 0),
    'tasks_completed', COALESCE((SELECT n FROM tasks_done t WHERE t.department_id = d.id), 0),
    'cost_krw', COALESCE((SELECT cost_krw FROM log_counts lc WHERE lc.department_id = d.id), 0)
  ) ORDER BY d.name), '[]'::jsonb)
  FROM depts d;
$$;

COMMENT ON FUNCTION public.adoption_by_department(uuid, uuid[], timestamptz, timestamptz) IS
  '부서별 도입 현황(숫자만, 하위 부서를 올려 더하지 않음) — 관리자 보고서의 부서별 표(adoption-report.ts)가 부른다.';
REVOKE ALL ON FUNCTION public.adoption_by_department(uuid, uuid[], timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.adoption_by_department(uuid, uuid[], timestamptz, timestamptz) TO service_role;
NOTIFY pgrst, 'reload schema';
