-- 0053: 입력형 앱의 시험 판 (src/lib/apps/draft.ts, /api/agents/[id]/app-draft)
--
-- 부서 앱은 그 부서 직원 누구나 고칠 수 있는데(canEditAgent), 저장이 곧 배포라 한 사람의 수정이 부서 전원의 실행·예약·연동을
-- 그 순간 바꿨다(예약은 판이 바뀌면 멈춘다). 그래서 고친 설정을 먼저 '시험 판'으로 두고, 고칠 수 있는 사람만 시험 실행해 본 뒤
-- '배포'(save_agent — 판 번호·판 기록)로 올린다. 시험 판은 판 기록(agent_history)·판 사본(agent_snapshot)에 들어가지 않는다.
--
-- 값: { settings: {name, description, category, system_prompt, app_definition, capabilities}, base_version, saved_by, saved_at }
-- 추가만. 여러 번 적용해도 안전. **코드 배포 전에 반드시 적용** — 대화 실행기(prepare.ts)가 모든 대화에서 이 칸을 select 하므로,
-- 칸이 없으면 비서 조회가 실패해 **모든 대화가 멈춘다**(0047의 users.deleted_at과 같은 꼴).
ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS app_draft jsonb;
ALTER TABLE public.agents DROP CONSTRAINT IF EXISTS agents_app_draft_shape;
-- 빠진 키는 jsonb_typeof가 NULL이라 COALESCE로 막는다(NULL 비교는 CHECK를 통과시킨다)
ALTER TABLE public.agents ADD CONSTRAINT agents_app_draft_shape CHECK (
  app_draft IS NULL OR (
    jsonb_typeof(app_draft) = 'object'
    AND COALESCE(jsonb_typeof(app_draft->'settings'), '') = 'object'
    AND COALESCE(jsonb_typeof(app_draft->'base_version'), '') = 'number'
    AND COALESCE(jsonb_typeof(app_draft->'saved_at'), '') = 'string'
  )
);
COMMENT ON COLUMN public.agents.app_draft IS
  '입력형 앱의 배포 전 시험 판(0053). 배포하면 save_agent로 판을 올리고 비운다. 고칠 수 있는 사람만 보고 실행한다.';
NOTIFY pgrst, 'reload schema';
