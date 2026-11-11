-- 0089: 관리자 '앱 실행 현황'(src/lib/apps/run-overview.ts)·기관 통계 API app-runs가 시험 판 실행을 세지 않게 — 0046 app_run_states를 같은 이름·인자·반환으로 다시 정의.
--
-- 부서·공식 앱의 시험 판 실행(0053)은 답변 행 source_references.app_draft에 표시가 남는다. 예전에는 이 함수가 그 행도 세어
-- 앱 빌더에서 시험 실행을 여러 번 하면 '실행·중단·자주 멈춘 단계'가 부풀었다. 이제 마지막 답변이 시험 판 실행인 대화는 뺀다.
-- 답변을 남기지 못한 실행(답변 행 없음)은 시험 판인지 알 수 없어 예전처럼 센다.
-- 여러 번 적용해도 안전. 실행 권한은 service_role만(다시 건다). 코드 배포 전후 어느 쪽이든 된다(코드는 바뀐 것 없이 같은 함수를 부른다).
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
     -- 시험 판 실행(0053)은 세지 않는다
     AND NOT coalesce(m.source_references ? 'app_draft', false)
   ORDER BY c.created_at DESC, c.id DESC
   LIMIT least(greatest(coalesce(p_limit, 1), 1), 5001);
$$;
REVOKE ALL ON FUNCTION public.app_run_states(uuid[], timestamptz, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_run_states(uuid[], timestamptz, int) TO service_role;
NOTIFY pgrst, 'reload schema';
