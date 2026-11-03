-- 입력형 앱 예약 실행(src/lib/apps/schedules.ts). 직원이 저장한 입력으로 앱을 정해진 시각(한국 시간)에 자동 실행한다.
-- 추가만(기존 표 무변경). 여러 번 적용해도 안전. RLS 켜고 정책 없음(서비스 키만).
-- 실행은 /api/cron/app-schedules(CRON_SECRET)를 pg_cron이 5분마다 부르는 것으로 돈다 — docs/benchmarks/allganize/APP_SCHEDULES.md.
CREATE TABLE IF NOT EXISTS public.app_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  -- 예약을 만든 직원. 실행도 이 사람의 권한·사용량으로 한다
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- 예약을 만들 때의 앱 판. 앱 설정이 바뀌면(판이 다르면) 실행을 멈추고 알린다
  app_version integer NOT NULL,
  -- 저장한 입력값(항목 키 → 글). 파일 입력은 예약할 수 없다
  inputs jsonb NOT NULL CHECK (jsonb_typeof(inputs) = 'object'),
  frequency text NOT NULL CHECK (frequency IN ('daily', 'weekdays', 'weekly', 'monthly')),
  -- weekly: 0(일)~6(토) · monthly: 1~28(모든 달에 있는 날만)
  weekday smallint CHECK (weekday BETWEEN 0 AND 6),
  month_day smallint CHECK (month_day BETWEEN 1 AND 28),
  run_hour smallint NOT NULL CHECK (run_hour BETWEEN 0 AND 23),
  run_minute smallint NOT NULL CHECK (run_minute IN (0, 30)),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  paused_reason text,
  next_run_at timestamptz NOT NULL,
  -- 실행기가 차지한 때(조건부 갱신). 15분 넘게 남아 있으면 멈춘 차지로 보고 다시 잡는다
  claimed_at timestamptz,
  last_run_at timestamptz,
  last_status text CHECK (last_status IN ('completed', 'failed')),
  last_error text,
  last_conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  consecutive_failures integer NOT NULL DEFAULT 0,
  run_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((frequency = 'weekly') = (weekday IS NOT NULL)),
  CHECK ((frequency = 'monthly') = (month_day IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS app_schedules_due_idx ON public.app_schedules (next_run_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS app_schedules_user_idx ON public.app_schedules (user_id);
ALTER TABLE public.app_schedules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_schedules FROM anon, authenticated;
NOTIFY pgrst, 'reload schema';
