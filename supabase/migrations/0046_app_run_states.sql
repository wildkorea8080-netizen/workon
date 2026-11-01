-- 관리자용 입력형 앱 실행 현황(src/lib/apps/run-overview.ts)이 쓰는 읽기 함수.
-- 답 메시지의 source_references.app_steps에는 단계마다 중간 결과(output)도 들어 있어, PostgREST로 고르면
-- 결과 글까지 서버로 내려온다. 이 함수는 **단계 이름(40자)·상태만** 돌려준다 — 입력·결과·질문·실행한 사람은 내보내지 않는다.
-- 추가만(기존 표 무변경). 여러 번 적용해도 안전. 실행 권한은 service_role만.
CREATE OR REPLACE FUNCTION public.app_run_states(p_agent_ids uuid[], p_since timestamptz, p_limit int)
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
   ORDER BY c.created_at DESC, c.id DESC
   LIMIT least(greatest(coalesce(p_limit, 1), 1), 5001);
$$;
REVOKE ALL ON FUNCTION public.app_run_states(uuid[], timestamptz, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_run_states(uuid[], timestamptz, int) TO service_role;
NOTIFY pgrst, 'reload schema';
