-- 입력형 앱 외부 연동(Webhook) — 직원이 앱마다 연동 토큰을 만들면, 외부 시스템이 그 토큰으로 입력값을 보내 그 직원의 권한으로 앱을 실행한다
-- (src/lib/apps/webhooks.ts, docs/benchmarks/allganize/APP_WEBHOOKS.md). 토큰 원문은 저장하지 않고 SHA-256만 둔다.
-- 추가만(기존 표 무변경). 여러 번 적용해도 안전. RLS 켜고 정책 없음(서비스 키만).
CREATE TABLE IF NOT EXISTS public.app_webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  -- 연동을 만든 직원. 실행도 이 사람의 권한·사용량으로 한다
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- 만들 때의 앱 판. 앱 설정이 바뀌면(판이 다르면) 호출을 409로 거절한다
  app_version integer NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- 화면에 보여 줄 앞부분(원문 앞 12자) — 어느 토큰인지 알아보는 데만 쓴다
  token_prefix text NOT NULL CHECK (char_length(token_prefix) BETWEEN 6 AND 16),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  use_count integer NOT NULL DEFAULT 0,
  -- 하루 호출 상한(한국 날짜 기준) — day_key가 오늘이 아니면 0부터 다시 센다
  day_key date,
  day_count integer NOT NULL DEFAULT 0,
  last_status text CHECK (last_status IN ('completed', 'failed')),
  last_error text,
  last_conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS app_webhooks_user_idx ON public.app_webhooks (user_id);
ALTER TABLE public.app_webhooks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_webhooks FROM anon, authenticated;

-- 호출 하나를 원자적으로 받는다: 토큰 행을 잠그고 유효(활성·만료 전)·간격·하루 상한을 본 뒤 사용 기록을 올린다.
-- 두 호출이 동시에 와도 행 잠금 때문에 하나만 통과한다(간격 안의 둘째는 too_soon). 무효 사유는 하나로 묶는다(invalid — 없음·회수·만료를 밖에 가르지 않는다)
CREATE OR REPLACE FUNCTION public.app_webhook_claim(p_token_hash text, p_now timestamptz, p_min_interval_seconds integer, p_daily_limit integer)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  w public.app_webhooks%ROWTYPE;
  today date := (p_now AT TIME ZONE 'Asia/Seoul')::date;
  wait integer;
BEGIN
  SELECT * INTO w FROM public.app_webhooks WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR w.status <> 'active' OR w.expires_at <= p_now THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;
  IF w.last_used_at IS NOT NULL AND w.last_used_at > p_now - make_interval(secs => p_min_interval_seconds) THEN
    wait := ceil(extract(epoch FROM (w.last_used_at + make_interval(secs => p_min_interval_seconds) - p_now)))::integer;
    RETURN jsonb_build_object('ok', false, 'reason', 'too_soon', 'retry_after', greatest(wait, 1));
  END IF;
  IF w.day_key = today AND w.day_count >= p_daily_limit THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'daily_limit');
  END IF;
  UPDATE public.app_webhooks
     SET last_used_at = p_now,
         use_count = use_count + 1,
         day_count = CASE WHEN day_key = today THEN day_count + 1 ELSE 1 END,
         day_key = today,
         updated_at = p_now
   WHERE id = w.id;
  RETURN jsonb_build_object('ok', true, 'webhook', jsonb_build_object(
    'id', w.id, 'agent_id', w.agent_id, 'user_id', w.user_id, 'department_id', w.department_id,
    'organization_id', w.organization_id, 'app_version', w.app_version));
END $$;
REVOKE ALL ON FUNCTION public.app_webhook_claim(text, timestamptz, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_webhook_claim(text, timestamptz, integer, integer) TO service_role;
NOTIFY pgrst, 'reload schema';
