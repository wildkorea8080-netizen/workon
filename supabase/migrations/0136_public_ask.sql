-- 0136: 시민용 민원 상담 창 (src/lib/public-ask/ · /ask/{slug} · /api/ask/{slug} · /api/admin/public-ask)
--
-- 시민이 로그인 없이 기관의 '시민 전용 비서'에게 묻고 그 비서 문서만 근거로 답을 받는다(설계 docs/superpowers/specs/2026-11-27-public-ask-design.md).
-- ① agents.tier에 'public'(시민 전용 비서) — 기관마다 하나. 직원 목록은 tier로 거르므로 저절로 빠지고, 권한 함수가 직원 사용을 거절한다.
-- ② public_ask_settings — 기관마다 한 행(켜짐·비서·안내 문구·자주 묻는 질문·부서 연락처·허용 홈페이지·하루 상한)
-- ③ public_ask_logs — 질문마다 한 줄, 30일 보관(5분 실행기가 지움). IP는 해시만. 개인정보·마감으로 거절한 시도는 질문 글 없이
-- ④ public_ask_claim — 기관마다 잠그고 오늘 횟수를 세어 넘으면 마감, 아니면 'answering' 줄을 넣고 id를 돌려준다(동시에 와도 상한을 넘지 않게)
-- ⑤ department_spend_krw — 'public_ask' 사용 기록을 부서 사용액에서 뺀다(시민 질문이 그 부서 직원의 월 한도를 쓰지 않게, 기관 예산에는 그대로 든다)
-- ⑥ organization_chat_tokens — 종량제 월 토큰 한도에 'public_ask' 토큰도 센다(연간 정액은 organization_spend_krw가 모든 원가를 이미 센다)
-- 추가만(값 넓힘·새 표·새 함수·함수 다시 정의), 여러 번 적용해도 안전, RLS 켜고 정책 없음·공개 키 권한 없음.
-- 코드 배포 전에 적용 — 새 코드가 시민 상담 표를 읽고 tier 'public' 비서를 만든다(없으면 시민 상담 화면·API만 실패).

-- ① 시민 전용 비서
ALTER TABLE public.agents DROP CONSTRAINT IF EXISTS agents_tier_check;
ALTER TABLE public.agents ADD CONSTRAINT agents_tier_check CHECK (tier IN ('personal', 'department', 'official', 'public'));
CREATE UNIQUE INDEX IF NOT EXISTS agents_public_one_per_org ON public.agents (organization_id) WHERE tier = 'public' AND deleted_at IS NULL;

-- ② 설정
CREATE TABLE IF NOT EXISTS public.public_ask_settings (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  enabled_at timestamptz,
  enabled_reason text,
  agent_id uuid REFERENCES public.agents(id) ON DELETE SET NULL,
  notice text NOT NULL DEFAULT '',
  faq text[] NOT NULL DEFAULT '{}',
  contacts jsonb NOT NULL DEFAULT '[]'::jsonb,
  allowed_origins text[] NOT NULL DEFAULT '{}',
  ip_daily_cap integer NOT NULL DEFAULT 20,
  org_daily_cap integer NOT NULL DEFAULT 500,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT public_ask_settings_enabled_pair CHECK (NOT enabled OR (enabled_at IS NOT NULL AND enabled_reason IS NOT NULL AND char_length(enabled_reason) BETWEEN 1 AND 300)),
  CONSTRAINT public_ask_settings_notice_len CHECK (char_length(notice) <= 500),
  CONSTRAINT public_ask_settings_faq_count CHECK (cardinality(faq) <= 5),
  CONSTRAINT public_ask_settings_contacts_shape CHECK (jsonb_typeof(contacts) = 'array' AND jsonb_array_length(contacts) <= 10),
  CONSTRAINT public_ask_settings_origins_count CHECK (cardinality(allowed_origins) <= 5),
  CONSTRAINT public_ask_settings_ip_cap CHECK (ip_daily_cap BETWEEN 1 AND 100),
  CONSTRAINT public_ask_settings_org_cap CHECK (org_daily_cap BETWEEN 1 AND 5000)
);

-- ③ 기록
CREATE TABLE IF NOT EXISTS public.public_ask_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  ip_hash text NOT NULL,
  result text NOT NULL,
  question text,
  answer text,
  sources text[] NOT NULL DEFAULT '{}',
  model text,
  input_tokens integer,
  output_tokens integer,
  CONSTRAINT public_ask_logs_ip_hash CHECK (ip_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT public_ask_logs_result CHECK (result IN ('answering', 'answered', 'no_source', 'rejected_pii', 'capped_ip', 'capped_org', 'unavailable')),
  CONSTRAINT public_ask_logs_question_len CHECK (question IS NULL OR char_length(question) <= 1000),
  CONSTRAINT public_ask_logs_answer_len CHECK (answer IS NULL OR char_length(answer) <= 8000),
  -- 거절·마감한 시도는 질문 글을 남기지 않는다
  CONSTRAINT public_ask_logs_no_text_when_rejected CHECK (result NOT IN ('rejected_pii', 'capped_ip', 'capped_org') OR (question IS NULL AND answer IS NULL))
);
CREATE INDEX IF NOT EXISTS public_ask_logs_org_created ON public.public_ask_logs (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS public_ask_logs_org_ip_created ON public.public_ask_logs (organization_id, ip_hash, created_at);

ALTER TABLE public.public_ask_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_ask_logs ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON public.public_ask_settings FROM anon';
    EXECUTE 'REVOKE ALL ON public.public_ask_logs FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON public.public_ask_settings FROM authenticated';
    EXECUTE 'REVOKE ALL ON public.public_ask_logs FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.public_ask_settings TO service_role';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.public_ask_logs TO service_role';
  END IF;
END $$;

-- ④ 오늘 횟수를 세고 넣기 — IP 상한은 모든 시도, 기관 상한은 모델을 부른(부르는 중) 시도만
CREATE OR REPLACE FUNCTION public.public_ask_claim(p_org uuid, p_ip_hash text, p_day_start timestamptz, p_ip_cap integer, p_org_cap integer)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_ip integer;
  v_org integer;
  v_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('public_ask:' || p_org::text, 0));
  SELECT count(*) INTO v_ip FROM public.public_ask_logs
    WHERE organization_id = p_org AND ip_hash = p_ip_hash AND created_at >= p_day_start;
  IF v_ip >= p_ip_cap THEN
    INSERT INTO public.public_ask_logs (organization_id, ip_hash, result) VALUES (p_org, p_ip_hash, 'capped_ip');
    RETURN jsonb_build_object('status', 'capped_ip');
  END IF;
  SELECT count(*) INTO v_org FROM public.public_ask_logs
    WHERE organization_id = p_org AND created_at >= p_day_start AND result IN ('answering', 'answered', 'no_source');
  IF v_org >= p_org_cap THEN
    INSERT INTO public.public_ask_logs (organization_id, ip_hash, result) VALUES (p_org, p_ip_hash, 'capped_org');
    RETURN jsonb_build_object('status', 'capped_org');
  END IF;
  INSERT INTO public.public_ask_logs (organization_id, ip_hash, result) VALUES (p_org, p_ip_hash, 'answering') RETURNING id INTO v_id;
  RETURN jsonb_build_object('status', 'ok', 'id', v_id);
END;
$$;

REVOKE ALL ON FUNCTION public.public_ask_claim(uuid, text, timestamptz, integer, integer) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.public_ask_claim(uuid, text, timestamptz, integer, integer) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.public_ask_claim(uuid, text, timestamptz, integer, integer) FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.public_ask_claim(uuid, text, timestamptz, integer, integer) TO service_role';
  END IF;
END $$;

-- ⑤ 부서 사용액에서 시민 상담을 뺀다(0024와 같은 본문 + action 조건)
CREATE OR REPLACE FUNCTION department_spend_krw(
  p_department_id uuid,
  p_from timestamptz,
  p_to   timestamptz
)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(SUM((details->>'cost_krw')::numeric), 0)
  FROM usage_logs
  WHERE department_id = p_department_id
    AND created_at >= p_from
    AND created_at <= p_to
    AND details ? 'cost_krw'
    AND action <> 'public_ask';
$$;

-- ⑥ 기관 월 토큰 합에 시민 상담도(0057과 같은 본문 + action 'public_ask')
CREATE OR REPLACE FUNCTION public.organization_chat_tokens(
  p_organization_id uuid,
  p_from timestamptz
)
RETURNS bigint
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(sum(
    COALESCE(CASE WHEN jsonb_typeof(details->'input_tokens') = 'number' THEN (details->>'input_tokens')::numeric END, 0)
    + COALESCE(CASE WHEN jsonb_typeof(details->'output_tokens') = 'number' THEN (details->>'output_tokens')::numeric END, 0)
  ), 0)::bigint
  FROM usage_logs
  WHERE organization_id = p_organization_id
    AND action IN ('chat_message', 'public_ask')
    AND created_at >= p_from;
$$;
REVOKE ALL ON FUNCTION public.organization_chat_tokens(uuid, timestamptz) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.organization_chat_tokens(uuid, timestamptz) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.organization_chat_tokens(uuid, timestamptz) FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.organization_chat_tokens(uuid, timestamptz) TO service_role';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
