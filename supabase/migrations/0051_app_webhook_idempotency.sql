-- 입력형 앱 외부 연동의 재시도 중복 막기(Idempotency-Key) — src/lib/apps/webhooks.ts, docs/benchmarks/allganize/APP_WEBHOOKS.md.
-- 외부 시스템은 응답을 못 받으면 같은 요청을 다시 보낸다. 같은 연동·같은 키의 호출은 24시간 동안 앱을 다시 돌리지 않고 처음 결과(상태·대화 id)를 돌려준다.
-- 추가만(표 하나 + 차지 함수에 기본값 있는 인자 둘). 여러 번 적용해도 안전. **코드 배포 전에 적용** — 옛 코드의 4인자 호출도 그대로 돈다.
CREATE TABLE IF NOT EXISTS public.app_webhook_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id uuid NOT NULL REFERENCES public.app_webhooks(id) ON DELETE CASCADE,
  -- 외부 시스템이 정한 키(영문·숫자·_.:- 1~100자). 연동마다 따로 센다
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  -- 입력값의 SHA-256(키 순서를 맞춘 JSON) — 같은 키로 다른 입력을 보내면 거절한다. 입력값 자체는 저장하지 않는다
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done')),
  -- 처음 호출의 응답(상태 코드·대화 id·안내 문구). 앱 결과 글은 싣지 않는다
  http_status integer CHECK (http_status BETWEEN 200 AND 499),
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  message text CHECK (message IS NULL OR char_length(message) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (webhook_id, idempotency_key),
  CHECK ((status = 'done') = (http_status IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS app_webhook_calls_webhook_created_idx ON public.app_webhook_calls (webhook_id, created_at);
ALTER TABLE public.app_webhook_calls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_webhook_calls FROM anon, authenticated;

-- 차지 함수: 토큰 행을 잠근 채(동시 재시도도 하나씩) ① 유효 → ② 키가 있으면 24시간 안 같은 키를 본다
--   (입력이 다르면 key_mismatch, 처리 중이면 in_progress, 끝났으면 replay — 간격·하루 상한·사용 횟수를 쓰지 않는다.
--    10분 넘게 running이면 멈춘 실행으로 보고 지운 뒤 새로 받는다) → ③ 간격·하루 상한 → ④ 사용 기록 + 키가 있으면 running 행
DROP FUNCTION IF EXISTS public.app_webhook_claim(text, timestamptz, integer, integer);
CREATE OR REPLACE FUNCTION public.app_webhook_claim(
  p_token_hash text, p_now timestamptz, p_min_interval_seconds integer, p_daily_limit integer,
  p_idempotency_key text DEFAULT NULL, p_request_hash text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  w public.app_webhooks%ROWTYPE;
  c public.app_webhook_calls%ROWTYPE;
  today date := (p_now AT TIME ZONE 'Asia/Seoul')::date;
  wait integer;
  call_id uuid;
BEGIN
  SELECT * INTO w FROM public.app_webhooks WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR w.status <> 'active' OR w.expires_at <= p_now THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    -- 24시간 지난 기록은 키를 다시 쓸 수 있게 지운다(이 연동 것만)
    DELETE FROM public.app_webhook_calls WHERE webhook_id = w.id AND created_at <= p_now - interval '24 hours';
    SELECT * INTO c FROM public.app_webhook_calls WHERE webhook_id = w.id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      IF c.request_hash IS DISTINCT FROM p_request_hash THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'key_mismatch');
      END IF;
      IF c.status = 'done' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'replay', 'call', jsonb_build_object(
          'http_status', c.http_status, 'conversation_id', c.conversation_id, 'message', c.message));
      END IF;
      IF c.created_at > p_now - interval '10 minutes' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'in_progress');
      END IF;
      DELETE FROM public.app_webhook_calls WHERE id = c.id;
    END IF;
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
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO public.app_webhook_calls (webhook_id, idempotency_key, request_hash, created_at, updated_at)
    VALUES (w.id, p_idempotency_key, p_request_hash, p_now, p_now) RETURNING id INTO call_id;
  END IF;
  RETURN jsonb_build_object('ok', true, 'call_id', call_id, 'webhook', jsonb_build_object(
    'id', w.id, 'agent_id', w.agent_id, 'user_id', w.user_id, 'department_id', w.department_id,
    'organization_id', w.organization_id, 'app_version', w.app_version));
END $$;
REVOKE ALL ON FUNCTION public.app_webhook_claim(text, timestamptz, integer, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_webhook_claim(text, timestamptz, integer, integer, text, text) TO service_role;
NOTIFY pgrst, 'reload schema';
