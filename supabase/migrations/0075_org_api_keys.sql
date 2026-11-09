-- 기관 통계 읽기 API 키(2026-11-09) — 기관 전체 관리자가 범위(scope)를 정해 키를 만들면, 기관의 다른 시스템(내부 대시보드·보고 시스템)이
-- `GET /api/v1/…`(Bearer)으로 **숫자만** 읽는다(도입 현황·부서별 도입 현황·비서별/부서별 이용통계 — 직원 이름·질문·결과 글은 없음).
-- (src/lib/org-api/keys.ts, docs/benchmarks/allganize/ORG_API.md). 키 원문은 저장하지 않고 SHA-256만 둔다.
-- 추가만(기존 표 무변경). 여러 번 적용해도 안전. RLS 켜고 정책 없음(서비스 키만).
CREATE TABLE IF NOT EXISTS public.org_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- 키를 만든 기관 전체 관리자. 호출 때마다 이 사람이 아직 그 기관의 전체 관리자인지 다시 본다(아니면 403)
  created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- 화면에 보여 줄 앞부분 — 어느 키인지 알아보는 데만 쓴다
  token_prefix text NOT NULL CHECK (char_length(token_prefix) BETWEEN 6 AND 16),
  -- 읽을 수 있는 범위: adoption(도입 현황·부서별 도입 현황) · usage(비서별·부서별 이용통계)
  scopes text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 2 AND scopes <@ ARRAY['adoption', 'usage']::text[]),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  last_used_at timestamptz,
  use_count integer NOT NULL DEFAULT 0,
  -- 하루 호출 상한(한국 날짜 기준) — day_key가 오늘이 아니면 0부터 다시 센다
  day_key date,
  day_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS org_api_keys_org_idx ON public.org_api_keys (organization_id, created_at DESC);
ALTER TABLE public.org_api_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.org_api_keys FROM anon, authenticated;

-- 호출 기록(감사) — 어느 키가 언제 무엇을 읽었고 결과가 무엇이었는지. 요청 값·응답 내용은 남기지 않는다
CREATE TABLE IF NOT EXISTS public.org_api_key_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id uuid NOT NULL REFERENCES public.org_api_keys(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  endpoint text NOT NULL CHECK (endpoint IN ('adoption-report', 'adoption-departments', 'usage-summary')),
  http_status integer NOT NULL CHECK (http_status BETWEEN 100 AND 599),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS org_api_key_calls_org_idx ON public.org_api_key_calls (organization_id, created_at DESC);
ALTER TABLE public.org_api_key_calls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.org_api_key_calls FROM anon, authenticated;

-- 호출 하나를 원자적으로 받는다: 키 행을 잠그고 유효(활성·만료 전)·하루 상한을 본 뒤 사용 기록을 올린다.
-- 무효 사유는 하나로 묶는다(invalid — 없음·회수·만료를 밖에 가르지 않는다)
CREATE OR REPLACE FUNCTION public.org_api_key_claim(p_token_hash text, p_now timestamptz, p_daily_limit integer)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  k public.org_api_keys%ROWTYPE;
  today date := (p_now AT TIME ZONE 'Asia/Seoul')::date;
BEGIN
  SELECT * INTO k FROM public.org_api_keys WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR k.status <> 'active' OR k.expires_at <= p_now THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;
  IF k.day_key = today AND k.day_count >= p_daily_limit THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'daily_limit', 'key_id', k.id, 'organization_id', k.organization_id);
  END IF;
  UPDATE public.org_api_keys
     SET last_used_at = p_now,
         use_count = use_count + 1,
         day_count = CASE WHEN day_key = today THEN day_count + 1 ELSE 1 END,
         day_key = today,
         updated_at = p_now
   WHERE id = k.id;
  RETURN jsonb_build_object('ok', true, 'key', jsonb_build_object(
    'id', k.id, 'organization_id', k.organization_id, 'created_by', k.created_by, 'scopes', to_jsonb(k.scopes)));
END $$;
REVOKE ALL ON FUNCTION public.org_api_key_claim(text, timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.org_api_key_claim(text, timestamptz, integer) TO service_role;
NOTIFY pgrst, 'reload schema';
