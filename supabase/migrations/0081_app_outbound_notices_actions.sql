-- 0081: 앱 결과 보내기의 알림·동작(2026-11-10) — src/lib/apps/outbound/notices.ts·spec.ts, docs/benchmarks/allganize/APP_OUTBOUND.md
-- ① 그만둔 보내기 알림: 보낼 곳마다 기관 전체 관리자에게 6시간에 한 번 — 마지막으로 알린 때(조건부로 차지)
-- ② 보내기 전 확인 알림: 확인을 기다리는 결과마다 실행한 직원에게 한 번 — 알린 때
-- ③ 동작: 기관 전체 관리자가 보낼 곳마다 받는 쪽이 알아듣는 동작(키·이름, 5개까지 — 예 draft=기안 임시 저장)을 정하고,
--    앱이 그중 하나를 골라 보낸다. 넣을 때의 동작 키를 기록에 남겨 보내는 몸·머리글에 싣는다.
-- 추가만(칸 넷·CHECK). 여러 번 적용해도 안전. 코드 배포 전에 적용 — 새 코드가 이 칸들을 읽고 써서, 없으면 보낼 곳 화면·보내기 넣기·실행기의 알림이 실패한다.
ALTER TABLE public.app_outbound_endpoints ADD COLUMN IF NOT EXISTS failure_notified_at timestamptz;
ALTER TABLE public.app_outbound_endpoints ADD COLUMN IF NOT EXISTS actions jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.app_outbound_deliveries ADD COLUMN IF NOT EXISTS approval_notified_at timestamptz;
ALTER TABLE public.app_outbound_deliveries ADD COLUMN IF NOT EXISTS action text;

ALTER TABLE public.app_outbound_endpoints DROP CONSTRAINT IF EXISTS app_outbound_endpoints_actions_check;
ALTER TABLE public.app_outbound_endpoints ADD CONSTRAINT app_outbound_endpoints_actions_check
  CHECK (jsonb_typeof(actions) = 'array' AND jsonb_array_length(actions) <= 5);

ALTER TABLE public.app_outbound_deliveries DROP CONSTRAINT IF EXISTS app_outbound_deliveries_action_check;
ALTER TABLE public.app_outbound_deliveries ADD CONSTRAINT app_outbound_deliveries_action_check
  CHECK (action IS NULL OR action ~ '^[a-z][a-z0-9_]{0,31}$');

-- 알리지 않은 확인 기다림 찾기
CREATE INDEX IF NOT EXISTS app_outbound_deliveries_unnotified_idx ON public.app_outbound_deliveries (created_at)
  WHERE status = 'awaiting_approval' AND approval_notified_at IS NULL;

NOTIFY pgrst, 'reload schema';
