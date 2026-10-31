-- 설정은 작업과 함께 보존한다. 기존 작업은 연결 없는 상태로 유지한다.
ALTER TABLE public.work_tasks ADD COLUMN IF NOT EXISTS app_snapshot jsonb;
ALTER TABLE public.work_tasks ADD CONSTRAINT work_app_snapshot_shape CHECK (
  app_snapshot IS NULL OR COALESCE((
    jsonb_typeof(app_snapshot) = 'object'
    AND app_snapshot->>'schemaVersion' = '1'
    AND app_snapshot->>'agentId' IS NOT NULL
    AND (agent_id IS NULL OR app_snapshot->>'agentId' = agent_id::text)
  ), false)
);
