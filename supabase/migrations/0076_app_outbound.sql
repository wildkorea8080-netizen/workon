-- 0076: 앱 결과를 외부 시스템으로 보내기(2026-11-09) — 기관 전체 관리자가 승인한 https 주소(보낼 곳)를 등록하면,
-- 입력형 앱이 실행을 마칠 때 그 결과 글을 서명(HMAC-SHA256)해 보낸다(src/lib/apps/outbound/*, docs/benchmarks/allganize/APP_OUTBOUND.md).
-- 보내기는 앱 예약 실행기(pg_cron, 5분마다)가 차례가 된 기록을 조건부로 차지해 한다 — 실패하면 1분·5분·30분·2시간 뒤 다시(5번까지).
-- 서명 비밀값은 되돌릴 수 있게 암호화해 둔다(보낼 때 서명해야 하므로 해시로 둘 수 없다). 보낸 결과 글은 저장하지 않는다(메시지에서 그때 읽는다).
-- 추가만(기존 표 무변경). 여러 번 적용해도 안전. RLS 켜고 정책 없음(서비스 키만). 코드 배포 전에 적용 — 없으면 보낼 곳 화면·보내기만 실패한다.
CREATE TABLE IF NOT EXISTS public.app_outbound_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  -- https만, 사용자 정보·443 밖 포트·사설 주소는 앱이 먼저 거른다(보낼 때 주소를 다시 풀어 다시 본다)
  url text NOT NULL CHECK (char_length(url) BETWEEN 12 AND 500 AND url LIKE 'https://%'),
  secret_encrypted text NOT NULL CHECK (char_length(secret_encrypted) BETWEEN 10 AND 400),
  -- 화면에 보여 줄 비밀값 앞부분 — 어느 비밀값인지 알아보는 데만
  secret_prefix text NOT NULL CHECK (char_length(secret_prefix) BETWEEN 6 AND 16),
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  revoked_reason text CHECK (revoked_reason IS NULL OR char_length(revoked_reason) BETWEEN 1 AND 300),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX IF NOT EXISTS app_outbound_endpoints_org_idx ON public.app_outbound_endpoints (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.app_outbound_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  endpoint_id uuid NOT NULL REFERENCES public.app_outbound_endpoints(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  -- 보낼 결과(답변 메시지) — 대화를 지우면 보내지 않은 기록도 함께 사라진다
  message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  -- pending: 보낼 차례를 기다림 · sending: 실행기가 차지함(10분 넘으면 다시 차지) · sent: 2xx를 받음 · gave_up: 그만둠(4xx·5번 실패·보낼 곳 회수)
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'gave_up')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  last_status integer CHECK (last_status IS NULL OR last_status BETWEEN 100 AND 599),
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  -- 같은 결과를 같은 곳에 두 번 넣지 않는다(이어 실행·다시 보내기에도 한 벌)
  UNIQUE (endpoint_id, message_id),
  CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  CHECK ((status = 'sending') = (claimed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS app_outbound_deliveries_due_idx ON public.app_outbound_deliveries (next_attempt_at) WHERE status IN ('pending', 'sending');
CREATE INDEX IF NOT EXISTS app_outbound_deliveries_org_idx ON public.app_outbound_deliveries (organization_id, created_at DESC);

ALTER TABLE public.app_outbound_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_outbound_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_outbound_endpoints FROM anon, authenticated;
REVOKE ALL ON public.app_outbound_deliveries FROM anon, authenticated;
NOTIFY pgrst, 'reload schema';
