-- 0057: 기관 월 토큰 합계를 DB에서 센다 (src/lib/usage-limit.ts)
--
-- 종량제 월 토큰 한도 판정(checkTokenLimit — 모든 대화 앞에서 돈다)과 예산 알림의 종량제 사용률은 이번 달 chat_message 기록을
-- 앱으로 읽어 토큰을 더했다. Supabase API는 한 번에 최대 행 수(기본 1,000)까지만 **오류 없이** 돌려주므로, 기관이 한 달에
-- 대화 1,000번을 넘기는 순간 합계가 더 늘지 않아 **한도가 걸리지 않고 알림도 덜 센다**(2026-11-05 발견). 매 대화마다 한 달 치
-- 기록을 끌어오는 비용도 함께 없앤다.
--
-- 합은 지금 코드와 같은 식: details의 input_tokens + output_tokens(없으면 0), action = 'chat_message', created_at >= p_from.
-- 함수·색인 추가만. 여러 번 적용해도 안전. 실행 권한 service_role만.
-- **코드 배포 전에 적용** — 없으면 한도 판정은 '확인 실패 = 허용'으로 열리고(기존 규칙) 예산 알림의 종량제 사용률만 실패한다.
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
    AND action = 'chat_message'
    AND created_at >= p_from;
$$;

COMMENT ON FUNCTION public.organization_chat_tokens(uuid, timestamptz) IS
  '기관의 기간 내 대화 토큰 합(입력+출력). 종량제 월 토큰 한도 판정·예산 알림이 쓴다(0057).';
REVOKE ALL ON FUNCTION public.organization_chat_tokens(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.organization_chat_tokens(uuid, timestamptz) TO service_role;

-- 모든 대화 앞에서 돈다 — 기관·기간으로 바로 찾게
CREATE INDEX IF NOT EXISTS idx_usage_logs_org_action_created ON public.usage_logs (organization_id, action, created_at DESC);
NOTIFY pgrst, 'reload schema';
