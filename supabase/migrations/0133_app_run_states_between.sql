-- 0133: 관리자 '앱 실행 현황'의 기간 고르기 — 끝 시각까지 받는 app_run_states_between (src/lib/apps/run-overview-load.ts)
--
-- app_run_states(0046·0089)는 시작 시각만 받아 '최근 30일'만 셀 수 있었다. 지난달처럼 끝이 과거인 기간을 앱에서 거르면
-- 그 뒤의 실행이 읽기 상한(2,001건)을 먼저 채워 기간 안 실행이 빠진다. 그래서 끝 시각(p_until, 그 앞까지)을 DB에서 건다.
-- 본문은 0089와 같다(단계 이름 40자·상태만, 시험 판 실행 제외). 새 이름이라 옛 함수는 그대로 남는다(옛 코드도 돈다).
-- 여러 번 적용해도 안전. 실행 권한은 service_role만. **코드 배포 전에 적용** — 새 코드가 이 함수를 불러, 없으면 앱 실행 현황·기관 통계 API app-runs만 실패한다.
CREATE OR REPLACE FUNCTION public.app_run_states_between(p_agent_ids uuid[], p_since timestamptz, p_until timestamptz, p_limit int)
RETURNS TABLE (agent_id uuid, created_at timestamptz, has_answer boolean, steps jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.agent_id,
         c.created_at,
         m.id IS NOT NULL,
         CASE WHEN jsonb_typeof(m.source_references -> 'app_steps') = 'array' THEN
           (SELECT coalesce(jsonb_agg(jsonb_build_object('name', left(e.s ->> 'name', 40), 'status', e.s ->> 'status') ORDER BY e.ord), '[]'::jsonb)
              FROM jsonb_array_elements(m.source_references -> 'app_steps') WITH ORDINALITY AS e(s, ord))
         END
    FROM public.conversations c
    LEFT JOIN LATERAL (
      SELECT mm.id, mm.source_references
        FROM public.messages mm
       WHERE mm.conversation_id = c.id AND mm.role = 'assistant'
       ORDER BY mm.created_at DESC, mm.id DESC
       LIMIT 1
    ) m ON true
   WHERE c.agent_id = ANY (p_agent_ids)
     AND c.created_at >= p_since
     AND c.created_at < p_until
     -- 시험 판 실행(0053)은 세지 않는다
     AND NOT coalesce(m.source_references ? 'app_draft', false)
   ORDER BY c.created_at DESC, c.id DESC
   LIMIT least(greatest(coalesce(p_limit, 1), 1), 5001);
$$;
REVOKE ALL ON FUNCTION public.app_run_states_between(uuid[], timestamptz, timestamptz, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_run_states_between(uuid[], timestamptz, timestamptz, int) TO service_role;
NOTIFY pgrst, 'reload schema';
