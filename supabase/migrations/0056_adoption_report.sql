-- 0056: 월별 도입 현황 보고서 집계 (src/lib/adoption-report.ts, /api/admin/adoption-report)
--
-- 기관 관리자가 한 달(KST)의 채택·완료·재작업 지표를 전월과 비교해 내보낸다. 공공기관은 도입 효과를 분기·연말에 보고한다.
-- '절약한 시간' 같은 추정치는 내지 않는다 — 기록된 사실만 센다.
--
-- PostgREST는 한 번에 1,000행까지만 돌려준다. 로그를 앱으로 끌어와 세면 큰 기관에서 조용히 덜 센다 — 집계는 DB가 한다.
-- 범위는 부서 id 목록(관리자의 관리 범위)과 기관 id. 직원·질문 원문·결과 글은 내보내지 않는다(숫자만).
-- 함수 추가만. 여러 번 적용해도 안전. 실행 권한 service_role만. 코드 배포 전에 적용 — 없으면 보고서 화면·API만 실패한다.
CREATE OR REPLACE FUNCTION public.adoption_report(
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
  WITH scope_users AS (
    SELECT u.id
    FROM users u
    JOIN departments d ON d.id = u.department_id
    WHERE u.department_id = ANY(p_department_ids)
      AND d.organization_id = p_organization_id
      AND u.deleted_at IS NULL
      AND COALESCE(u.is_super_admin, false) = false
  ),
  logs AS (
    SELECT l.user_id, l.action, l.details, l.created_at
    FROM usage_logs l
    WHERE l.department_id = ANY(p_department_ids)
      AND l.created_at >= p_from AND l.created_at < p_to
  ),
  user_days AS (
    -- 그 달에 AI를 쓴 날 수(한국 날짜) — 한 번 써 본 사람과 일하는 데 쓰는 사람을 가른다
    SELECT user_id, count(DISTINCT (created_at AT TIME ZONE 'Asia/Seoul')::date) AS days
    FROM logs
    WHERE user_id IN (SELECT id FROM scope_users)
    GROUP BY user_id
  ),
  tasks AS (
    SELECT t.id, t.created_at, t.approved_at, t.status
    FROM work_tasks t
    WHERE t.organization_id = p_organization_id
      AND t.department_id = ANY(p_department_ids)
  ),
  completed AS (
    SELECT id FROM tasks WHERE approved_at >= p_from AND approved_at < p_to
  ),
  app_conversations AS (
    SELECT c.id, c.agent_id
    FROM conversations c
    JOIN agents a ON a.id = c.agent_id
    WHERE c.department_id = ANY(p_department_ids)
      AND c.created_at >= p_from AND c.created_at < p_to
      AND a.app_definition IS NOT NULL
  )
  SELECT jsonb_build_object(
    'registered_users', (SELECT count(*) FROM users u WHERE u.id IN (SELECT id FROM scope_users) AND u.is_active IS TRUE),
    'active_users',     (SELECT count(*) FROM user_days),
    'regular_users',    (SELECT count(*) FROM user_days WHERE days >= 4),
    'chat_messages',    (SELECT count(*) FROM logs WHERE action = 'chat_message'),
    'conversations',    (SELECT count(*) FROM conversations c WHERE c.department_id = ANY(p_department_ids) AND c.created_at >= p_from AND c.created_at < p_to),
    'app_runs',         (SELECT count(*) FROM app_conversations),
    'apps_used',        (SELECT count(DISTINCT agent_id) FROM app_conversations),
    'documents_generated', (SELECT count(*) FROM logs WHERE action IN ('document_generated', 'table_merged')),
    'cost_krw',         (SELECT COALESCE(sum((details->>'cost_krw')::numeric), 0) FROM logs WHERE details ? 'cost_krw'),
    'tasks_created',    (SELECT count(*) FROM tasks WHERE created_at >= p_from AND created_at < p_to),
    'tasks_completed',  (SELECT count(*) FROM completed),
    'artifacts',        (SELECT count(*) FROM work_artifacts a WHERE a.organization_id = p_organization_id AND a.task_id IN (SELECT id FROM tasks) AND a.created_at >= p_from AND a.created_at < p_to),
    -- 재작업: 사람이 고친 판(직접 수정·AI 수정 적용)과 AI 수정 요청
    'edit_versions',    (SELECT count(*) FROM work_document_versions v WHERE v.organization_id = p_organization_id AND v.task_id IN (SELECT id FROM tasks) AND v.origin IN ('edit', 'revise') AND v.created_at >= p_from AND v.created_at < p_to),
    'revision_requests', (SELECT count(*) FROM work_revision_proposals r WHERE r.organization_id = p_organization_id AND r.task_id IN (SELECT id FROM tasks) AND r.created_at >= p_from AND r.created_at < p_to),
    -- 이번 달에 완료한 작업이 완료까지 만든 판 수(만들기 포함) — 1이면 처음 만든 그대로 완료
    'completed_versions', (SELECT count(*) FROM work_document_versions v WHERE v.organization_id = p_organization_id AND v.task_id IN (SELECT id FROM completed))
  );
$$;

COMMENT ON FUNCTION public.adoption_report(uuid, uuid[], timestamptz, timestamptz) IS
  '월별 도입 현황(채택·완료·재작업 숫자만) — 관리자 보고서(adoption-report.ts)가 이번 달·전월을 각각 부른다.';
REVOKE ALL ON FUNCTION public.adoption_report(uuid, uuid[], timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.adoption_report(uuid, uuid[], timestamptz, timestamptz) TO service_role;
NOTIFY pgrst, 'reload schema';
