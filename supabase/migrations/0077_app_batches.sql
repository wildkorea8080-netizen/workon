-- 0077: 입력형 앱 일괄 실행(2026-11-09) — 직원이 입력 여러 줄(표 붙여넣기·CSV, 100줄까지)을 올리면 앱을 줄마다 그 직원의 권한으로 실행하고,
-- 결과를 줄마다 모아 엑셀로 내려받는다(src/lib/apps/batches.ts, docs/benchmarks/allganize/APP_BATCHES.md).
-- 실행은 앱 예약 실행기(pg_cron, 5분마다)가 예약 실행과 나란히, 차례가 된 줄을 하나씩 조건부로 차지해 한다(손 실행·예약과 같은 대화 실행기 — 권한·한도·사용 기록이 같다).
-- 줄의 결과 글은 따로 저장하지 않는다(그 실행의 답변 메시지를 가리킨다).
-- 추가만(기존 표 무변경). 여러 번 적용해도 안전. RLS 켜고 정책 없음(서비스 키만). 코드 배포 전에 적용 — 없으면 일괄 실행 화면·API만 실패한다.
CREATE TABLE IF NOT EXISTS public.app_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- 만들 때의 부서 — 실행 때 직원의 지금 부서와 다르면 멈춘다(권한 범위가 바뀌었을 수 있다)
  department_id uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  -- 만들 때의 앱 판 — 실행 때 판이 바뀌었으면 멈춘다(입력 항목이 달라졌을 수 있다)
  app_version integer NOT NULL CHECK (app_version >= 1),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  -- running: 남은 줄을 실행 중 · done: 모든 줄을 마침 · cancelled: 직원이 그만둠 · stopped: 앱 변경·권한·한도로 멈춤
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'cancelled', 'stopped')),
  total integer NOT NULL CHECK (total BETWEEN 1 AND 100),
  stop_reason text CHECK (stop_reason IS NULL OR char_length(stop_reason) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK ((status = 'running') = (finished_at IS NULL)),
  CHECK ((status = 'stopped') = (stop_reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS app_batches_user_idx ON public.app_batches (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS app_batches_running_idx ON public.app_batches (created_at) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS public.app_batch_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.app_batches(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 100),
  inputs jsonb NOT NULL CHECK (jsonb_typeof(inputs) = 'object'),
  -- pending: 차례를 기다림 · running: 실행기가 차지함(15분 넘으면 다시 차지) · done · failed · skipped(묶음이 멈추거나 그만둬 실행하지 않음)
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  claimed_at timestamptz,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  error text CHECK (error IS NULL OR char_length(error) <= 300),
  finished_at timestamptz,
  UNIQUE (batch_id, position),
  CHECK ((status = 'running') = (claimed_at IS NOT NULL)),
  CHECK ((status IN ('done', 'failed', 'skipped')) = (finished_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS app_batch_items_open_idx ON public.app_batch_items (batch_id, position) WHERE status IN ('pending', 'running');

ALTER TABLE public.app_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_batch_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_batches FROM anon, authenticated;
REVOKE ALL ON public.app_batch_items FROM anon, authenticated;
NOTIFY pgrst, 'reload schema';
