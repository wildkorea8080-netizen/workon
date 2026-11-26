-- 0134: 앱 실행 현황의 '멈춘 까닭' — app_run_states_between(0133)이 단계마다 까닭 코드(cause, 20자)도 돌려준다 (src/lib/apps/run-cause.ts)
--
-- 2026-11-26부터 실행기가 멈춘 단계 기록에 정해 둔 까닭 코드(처리 시간 초과·사용 한도·AI 서비스·조회 실패 등 — 오류 원문은 아님)를 남긴다.
-- 같은 이름·인자·반환으로 다시 정의해 그 코드만 더 내보낸다(이름·상태·까닭 — 중간 결과 글은 여전히 안 나감). 까닭이 없는 옛 기록은 칸이 없다.
-- 여러 번 적용해도 안전. 실행 권한은 service_role만(다시 건다). 0133 뒤에 적용. 코드 배포 전후 어느 쪽이든 된다(없으면 까닭 칸만 비어 있다).
CREATE OR REPLACE FUNCTION public.app_run_states_between(p_agent_ids uuid[], p_since timestamptz, p_until timestamptz, p_limit int)
RETURNS TABLE (agent_id uuid, created_at timestamptz, has_answer boolean, steps jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.agent_id,
         c.created_at,
         m.id IS NOT NULL,
         CASE WHEN jsonb_typeof(m.source_references -> 'app_steps') = 'array' THEN
           (SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('name', left(e.s ->> 'name', 40), 'status', e.s ->> 'status', 'cause', left(e.s ->> 'cause', 20))) ORDER BY e.ord), '[]'::jsonb)
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
