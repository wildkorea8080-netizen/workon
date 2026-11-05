-- 0059: 문서 찾기 일괄 평가의 이름 붙인 세트 (src/lib/rag-eval-sets.ts, /api/admin/rag-eval/sets)
--
-- 0054의 평가 기록은 실행마다 세트를 품을 뿐이라, 세트를 따로 보관하거나 다른 비서에 같은 세트를 쓰기가 번거로웠다.
-- 기관 관리자가 '질문 · 기대 문서 · 기대 쪽' 세트에 이름을 붙여 기관 단위로 보관한다(비서에 묶지 않는다 — 같은 세트로 여러 비서를 잰다).
-- 세트 글은 서버가 다시 읽어 다듬은 꼴(탭 세 칸)로만 저장한다. 질문·문서 이름뿐이고 근거 원문은 없다.
-- 추가만(기존 표 무변경). 여러 번 적용해도 안전. RLS 켜고 정책 없음(서비스 키만). 코드 배포 전에 적용 — 없으면 세트 저장·목록만 실패한다.
CREATE TABLE IF NOT EXISTS public.rag_eval_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60 AND name = btrim(name)),
  set_text text NOT NULL CHECK (length(set_text) BETWEEN 1 AND 40000),
  question_count int NOT NULL CHECK (question_count BETWEEN 1 AND 50),
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- 기관 안에서 이름은 하나 — 같은 이름으로 저장하면 덮어쓸지 화면이 묻는다
CREATE UNIQUE INDEX IF NOT EXISTS rag_eval_sets_org_name_idx ON public.rag_eval_sets (organization_id, name);
ALTER TABLE public.rag_eval_sets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rag_eval_sets FROM anon, authenticated;
NOTIFY pgrst, 'reload schema';
