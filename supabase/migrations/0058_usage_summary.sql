-- 0058: 관리자 이용통계를 DB에서 묶는다 (src/app/api/admin/usage-summary/route.ts, src/lib/usage-summary.ts)
--
-- 이용통계(/admin/stats — 비서별·직원별·부서별)는 기간 안 사용 기록을 앱으로 읽어 묶었다. API 1,000행 상한 때문에
-- 2026-11-05에 쪽 읽기로 바꿨지만 50,000행에서 멈춰, 큰 기관이 긴 기간을 보면 '앞의 50,000건만' 셌다.
-- 이 함수는 (묶음 · 활동 · 모델)마다 횟수·입력/출력 토큰·원가를 DB에서 세어 jsonb 배열 하나로 돌려준다
-- (행 상한에 걸리지 않게 값 하나로). 이름 붙이기·정렬·CSV는 앱이 그대로 한다.
--
-- 셈은 앱이 하던 식과 같다:
--   - 묶음: agent = details.agent_id(비거나 없으면 뺌), user = user_id, department = department_id(없으면 '(알 수 없음)')
--   - 토큰·원가: 숫자는 그 값, 숫자로 읽히는 글자('12')는 그 값, 그 밖은 0
--     (앱의 Number()는 읽지 못하는 글자를 NaN으로 만들어 합계 전체를 망가뜨렸다 — 여기서는 0)
--   - 모델: 토큰을 쓴 기록만. details.model이 없으면 p_legacy_model(2026-08 이전 기록의 모델 — 앱의 LEGACY_PRICING_MODEL_ID)
--   - 기간: p_from 이상 p_to 이하
-- 범위(관리 부서)는 앱이 정해 넘긴다. 실행 권한 service_role만. 함수 추가만, 여러 번 적용해도 안전.
-- **코드 배포 전에 적용** — 없으면 이용통계 화면만 실패한다(대화·한도와 무관).

CREATE OR REPLACE FUNCTION public.usage_summary(
  p_department_ids uuid[],
  p_from timestamptz,
  p_to timestamptz,
  p_axis text,
  p_legacy_model text
) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH base AS (
    SELECT
      CASE p_axis
        WHEN 'agent' THEN NULLIF(l.details->>'agent_id', '')
        WHEN 'user' THEN COALESCE(l.user_id::text, '(알 수 없음)')
        ELSE COALESCE(l.department_id::text, '(알 수 없음)')
      END AS bucket,
      l.action,
      l.details->>'model' AS model_raw,
      v.inp, v.outp, v.cost
    FROM public.usage_logs l
    CROSS JOIN LATERAL (
      SELECT
        CASE jsonb_typeof(l.details->'input_tokens')
          WHEN 'number' THEN (l.details->>'input_tokens')::numeric
          WHEN 'string' THEN CASE WHEN (l.details->>'input_tokens') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' THEN trim(l.details->>'input_tokens')::numeric ELSE 0 END
          ELSE 0 END AS inp,
        CASE jsonb_typeof(l.details->'output_tokens')
          WHEN 'number' THEN (l.details->>'output_tokens')::numeric
          WHEN 'string' THEN CASE WHEN (l.details->>'output_tokens') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' THEN trim(l.details->>'output_tokens')::numeric ELSE 0 END
          ELSE 0 END AS outp,
        CASE jsonb_typeof(l.details->'cost_krw')
          WHEN 'number' THEN (l.details->>'cost_krw')::numeric
          WHEN 'string' THEN CASE WHEN (l.details->>'cost_krw') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' THEN trim(l.details->>'cost_krw')::numeric ELSE 0 END
          ELSE 0 END AS cost
    ) v
    WHERE l.department_id = ANY(p_department_ids)
      AND l.created_at >= p_from
      AND l.created_at <= p_to
  ),
  grouped AS (
    SELECT
      bucket,
      action,
      CASE WHEN inp > 0 OR outp > 0 THEN COALESCE(model_raw, p_legacy_model) END AS model,
      count(*) AS n,
      sum(inp) AS input_tokens,
      sum(outp) AS output_tokens,
      sum(cost) AS cost_krw
    FROM base
    WHERE bucket IS NOT NULL
    GROUP BY 1, 2, 3
  )
  SELECT COALESCE(
    jsonb_agg(jsonb_build_object(
      'bucket', bucket, 'action', action, 'model', model,
      'count', n, 'input_tokens', input_tokens, 'output_tokens', output_tokens, 'cost_krw', cost_krw
    ) ORDER BY bucket, action, model),
    '[]'::jsonb
  )
  FROM grouped;
$$;

REVOKE ALL ON FUNCTION public.usage_summary(uuid[], timestamptz, timestamptz, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.usage_summary(uuid[], timestamptz, timestamptz, text, text) TO service_role;

COMMENT ON FUNCTION public.usage_summary(uuid[], timestamptz, timestamptz, text, text) IS
  '관리자 이용통계(0058) — (묶음·활동·모델)마다 횟수·토큰·원가. 묶음 축 agent|user|department. 숫자만, 원문 없음.';

NOTIFY pgrst, 'reload schema';
