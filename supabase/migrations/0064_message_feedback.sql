-- 0064: 답변 평가 (src/lib/message-feedback.ts, PUT /api/messages/[id]/feedback, GET /api/admin/feedback-summary)
--
-- 직원이 AI 답변에 '도움됨 / 아쉬움'(+ 아쉬운 이유 하나)을 남기고, 기관 관리자가 비서별로 모아 본다(도입 효과의 만족도).
-- 이유는 정해 둔 코드만 받는다 — 자유 글을 받지 않아 관리자 화면에 직원이 쓴 글이 실리지 않는다. 질문·답변 원문은 이 표에 없다.
-- 답변 하나에 평가 하나(대화 주인만 남긴다). 대화를 지우면(탈퇴 처리 포함) 함께 지워진다.
-- 추가만(기존 표 무변경). 여러 번 적용해도 안전. RLS 켜고 정책 없음(서비스 키만). 코드 배포 전에 적용 — 없으면 평가 저장·요약만 실패하고 대화는 돈다.
CREATE TABLE IF NOT EXISTS public.message_feedback (
  message_id uuid PRIMARY KEY REFERENCES public.messages(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES public.agents(id) ON DELETE SET NULL,
  department_id uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- 답한 때의 비서 판(설정을 바꾼 뒤와 비교할 때 본다)
  agent_version int,
  rating text NOT NULL CHECK (rating IN ('up', 'down')),
  -- 아쉬움일 때만: 틀린 내용 · 근거 부족 · 답이 덜 됨 · 형식·표현 · 기타
  reason text CHECK (reason IS NULL OR reason IN ('wrong', 'no_evidence', 'incomplete', 'format', 'other')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_feedback_reason_only_down CHECK (rating = 'down' OR reason IS NULL)
);
CREATE INDEX IF NOT EXISTS message_feedback_org_updated_idx ON public.message_feedback (organization_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS message_feedback_conversation_idx ON public.message_feedback (conversation_id);
ALTER TABLE public.message_feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.message_feedback FROM anon, authenticated;
NOTIFY pgrst, 'reload schema';
