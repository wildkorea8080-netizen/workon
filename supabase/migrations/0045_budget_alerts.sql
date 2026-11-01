-- 기관·부서 예산 알림 메일 기록 — 같은 대상·같은 기간·같은 기준(%)은 한 번만 보낸다(src/lib/budget-alerts.ts).
-- 추가만(기존 표 무변경). 여러 번 적용해도 안전. RLS 켜고 정책 없음(서비스 키만).
CREATE TABLE IF NOT EXISTS public.budget_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- 'org'(기관 한도) 또는 'dept:{부서 id}'(부서 월 한도, 0024)
  subject text NOT NULL CHECK (subject ~ '^(org|dept:[0-9a-f-]{36})$'),
  -- 'contract:{계약 id}'(연간 정액) 또는 'month:YYYY-MM'(종량제·부서 월 한도, KST 달)
  period_key text NOT NULL CHECK (period_key ~ '^(contract:[0-9a-f-]{36}|month:[0-9]{4}-[0-9]{2})$'),
  threshold int NOT NULL CHECK (threshold BETWEEN 1 AND 100),
  kind text NOT NULL CHECK (kind IN ('annual_budget', 'monthly_tokens', 'department_monthly')),
  -- sending: 보내는 중(차지함) · sent: 한 명 이상 받음 · failed: 모두 실패(3번까지 다시) · no_recipients: 받을 사람 없음
  status text NOT NULL CHECK (status IN ('sending', 'sent', 'failed', 'no_recipients')),
  attempts int NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 10),
  percent int NOT NULL,
  -- 받은 사람 수만 — 주소는 남기지 않는다
  recipients int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, subject, period_key, threshold)
);
ALTER TABLE public.budget_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.budget_alerts FROM anon, authenticated;
NOTIFY pgrst, 'reload schema';
