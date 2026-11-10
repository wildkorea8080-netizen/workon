-- 0078: 앱 결과 보내기 전 사람 확인(2026-11-10) — 기관 전체 관리자가 보낼 곳(0076)마다 '보내기 전 확인'을 켜면,
-- 실행을 마친 결과는 곧바로 보내지 않고 **실행한 직원이 결과를 보고 '보내기'를 누를 때만** 보낸다(7일 안에 확인하지 않으면 보내지 않음).
-- (src/lib/apps/outbound/approval.ts, docs/benchmarks/allganize/APP_OUTBOUND.md)
-- 보내기 기록 상태에 awaiting_approval(직원 확인 기다림)·rejected(직원이 보내지 않기로 함)를 더하고, 누가 언제 정했는지 남긴다.
-- 추가만(값을 넓히고 칸을 더함). 여러 번 적용해도 안전. 코드 배포 전에 적용 — 새 코드가 require_approval을 읽어, 없으면 보낼 곳 화면·보내기 넣기가 실패한다.
ALTER TABLE public.app_outbound_endpoints ADD COLUMN IF NOT EXISTS require_approval boolean NOT NULL DEFAULT false;

ALTER TABLE public.app_outbound_deliveries ADD COLUMN IF NOT EXISTS decided_by uuid REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.app_outbound_deliveries ADD COLUMN IF NOT EXISTS decided_at timestamptz;

ALTER TABLE public.app_outbound_deliveries DROP CONSTRAINT IF EXISTS app_outbound_deliveries_status_check;
ALTER TABLE public.app_outbound_deliveries ADD CONSTRAINT app_outbound_deliveries_status_check
  CHECK (status IN ('awaiting_approval', 'pending', 'sending', 'sent', 'gave_up', 'rejected'));

-- 확인을 기다리는 기록은 아직 정하지 않았고, 보내지 않기로 한 기록은 정한 때가 있다.
-- 정한 사람이 있으면 정한 때도 있다(사람이 탈퇴해 칸이 비어도 정한 때는 남는다)
ALTER TABLE public.app_outbound_deliveries DROP CONSTRAINT IF EXISTS app_outbound_deliveries_decision_check;
ALTER TABLE public.app_outbound_deliveries ADD CONSTRAINT app_outbound_deliveries_decision_check
  CHECK ((status <> 'awaiting_approval' OR decided_at IS NULL) AND (status <> 'rejected' OR decided_at IS NOT NULL) AND (decided_by IS NULL OR decided_at IS NOT NULL));

-- 직원의 '확인할 결과' 목록
CREATE INDEX IF NOT EXISTS app_outbound_deliveries_awaiting_idx ON public.app_outbound_deliveries (user_id, created_at DESC) WHERE status = 'awaiting_approval';

NOTIFY pgrst, 'reload schema';
