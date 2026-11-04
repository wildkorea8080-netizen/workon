-- 0054: 배치 문서 찾기 평가 기록 (src/lib/rag-eval.ts, /api/admin/rag-eval)
--
-- 기관 관리자가 '질문 · 기대 문서 · 기대 쪽' 세트로 비서의 문서 찾기를 한 번에 재고, 그 결과를 남겨 다음 실행과 비교한다.
-- 검색만 잰다(AI 답변 없음). 결과에는 질문·기대값·판정·순위·상위 문서 이름·유사도만 — 근거 원문은 남기지 않는다.
-- 추가만(기존 표 무변경). 여러 번 적용해도 안전. RLS 켜고 정책 없음(서비스 키만). 코드 배포 전에 적용 — 없으면 평가 화면·API만 실패한다.
CREATE TABLE IF NOT EXISTS public.rag_eval_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  -- 그때의 비서 판(설정을 바꾼 뒤와 비교할 때 본다)
  agent_version int NOT NULL,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  question_count int NOT NULL CHECK (question_count BETWEEN 1 AND 50),
  -- done: 모든 질문을 찾음 · partial: 일부는 찾기 실패(error)
  status text NOT NULL CHECK (status IN ('done', 'partial')),
  summary jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
  results jsonb NOT NULL CHECK (jsonb_typeof(results) = 'array')
);
CREATE INDEX IF NOT EXISTS rag_eval_runs_agent_created_idx ON public.rag_eval_runs (organization_id, agent_id, created_at DESC);
ALTER TABLE public.rag_eval_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rag_eval_runs FROM anon, authenticated;
NOTIFY pgrst, 'reload schema';
