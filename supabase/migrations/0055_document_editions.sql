-- 0055: 비서 문서의 판(개정본) 관리 (src/lib/document-editions.ts)
--
-- 기관이 개정된 규정을 새로 올려도 옛 판이 그대로 남아, 대화가 폐지된 옛 규정을 근거로 답할 수 있었다.
-- 공통 자료실(0033)과 같은 규칙을 비서 문서에도 둔다:
--   - 새 문서를 올릴 때 '바꿀 옛 판'(replaces_id)을 고를 수 있다(같은 비서의 현재 판만 — 확인 라우트가 막는다).
--   - **새 판이 읽힌(ready) 순간** 옛 판의 NODA 사본을 지우고 'retired'·retired_at으로 둔다(행·원본은 감사용으로 남는다).
--     새 판이 읽기에 실패하면 옛 판이 계속 근거가 된다.
--   - 판 바꾸기가 끝나기 전에도 ready 새 판이 대신하는 옛 판은 근거로 치지 않는다(문서 찾기).
--   - effective_from: 시행일(선택, 표시용 — 시행일에 맞춰 자동으로 바꾸지는 않는다).
--
-- 추가만(기존 행은 그대로). 여러 번 적용해도 안전. **코드 배포 전에 반드시 적용** — 문서 찾기가 replaces_id를 select 하므로,
-- 칸이 없으면 문서가 있는 비서의 대화가 '참고 문서를 지금 불러오지 못했습니다'(503)로 막힌다.
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS replaces_id uuid REFERENCES public.documents(id) ON DELETE SET NULL;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS retired_at timestamptz;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS effective_from date;

ALTER TABLE public.documents DROP CONSTRAINT IF EXISTS documents_noda_status_check;
ALTER TABLE public.documents ADD CONSTRAINT documents_noda_status_check
  CHECK (noda_status IN ('reading', 'ready', 'failed', 'unreadable', 'deleting', 'retired'));
ALTER TABLE public.documents DROP CONSTRAINT IF EXISTS documents_replaces_not_self;
ALTER TABLE public.documents ADD CONSTRAINT documents_replaces_not_self CHECK (replaces_id IS NULL OR replaces_id <> id);
-- 지난 판 표시는 둘이 함께 — retired인데 시각이 없거나, 시각이 있는데 retired가 아닌 행을 막는다
ALTER TABLE public.documents DROP CONSTRAINT IF EXISTS documents_retired_pair;
ALTER TABLE public.documents ADD CONSTRAINT documents_retired_pair
  CHECK ((noda_status IS NOT DISTINCT FROM 'retired') = (retired_at IS NOT NULL));

CREATE INDEX IF NOT EXISTS documents_replaces_idx ON public.documents (replaces_id) WHERE replaces_id IS NOT NULL;

COMMENT ON COLUMN public.documents.replaces_id IS '이 문서가 대신하는 옛 판(0055). 새 판이 ready가 되면 옛 판을 retired로 둔다.';
COMMENT ON COLUMN public.documents.retired_at IS '지난 판이 된 때(0055). noda_status=retired와 함께만.';
COMMENT ON COLUMN public.documents.effective_from IS '시행일(선택, 0055) — 표시용.';
NOTIFY pgrst, 'reload schema';
