-- 0063: 입력형 앱 외부 연동에 '문서함에서 고른 문서' (src/lib/apps/webhooks.ts `executeWebhook` · library-documents.ts `currentEditionIds`)
--
-- 예약(0062)과 같다. 연동(0049)은 파일 입력을 받지 못했다. 문서함 문서는 연동을 만들 때 id로 저장하고, 외부 호출마다 그 문서의
-- 지금 근거 판으로 읽는다(새 판이 시행되면 새 판 — 판 사슬 replaces_id). 외부 시스템은 문서를 고르지 않는다(본문은 지금처럼 inputs뿐).
-- 3개까지. 외래 키는 두지 않는다 — 쓸 판이 없으면 호출을 422로 거절하고 다시 만들라고 알린다.
-- 추가만, 여러 번 적용해도 안전. 코드 배포 전에 적용 — 연동 목록·만들기·외부 호출이 이 칸을 읽어, 없으면 연동 화면이 503·외부 호출이 실패한다.
ALTER TABLE public.app_webhooks ADD COLUMN IF NOT EXISTS document_ids uuid[] NOT NULL DEFAULT '{}';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_webhooks_document_ids_count') THEN
    ALTER TABLE public.app_webhooks ADD CONSTRAINT app_webhooks_document_ids_count CHECK (cardinality(document_ids) <= 3);
  END IF;
END $$;
NOTIFY pgrst, 'reload schema';
