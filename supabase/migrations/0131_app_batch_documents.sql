-- 0131: 입력형 앱 일괄 실행에 '문서함에서 고른 문서' (src/lib/apps/batches.ts · library-documents.ts `currentEditionIds`)
--
-- 일괄 실행(0077)은 문서함 문서를 붙이지 못했다 — 문서함 고르기를 허용한 앱도 일괄 실행에서는 그 근거 없이 돌았다.
-- 예약(0062)·연동(0063)과 같이 묶음에 id로 저장해 두고 줄마다 실행 때 지금 근거 판으로 읽는다(판 사슬 replaces_id).
-- 모든 줄이 같은 문서를 쓴다(줄마다 다른 문서는 '파일마다 한 건'). 3개까지(앱 파일 상한 APP_MAX_FILES와 같다 — 파일마다 한 건이면 파일 하나를 더해 3개).
-- 외래 키는 두지 않는다 — 지워진 문서는 실행 때 알아보고 묶음을 멈춘다.
-- 추가만, 여러 번 적용해도 안전. 코드 배포 전에 적용 — 일괄 실행 목록·실행기가 이 칸을 select 해, 없으면 일괄 실행이 돌지 않는다.
ALTER TABLE public.app_batches ADD COLUMN IF NOT EXISTS document_ids uuid[] NOT NULL DEFAULT '{}';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_batches_document_ids_count') THEN
    ALTER TABLE public.app_batches ADD CONSTRAINT app_batches_document_ids_count CHECK (cardinality(document_ids) <= 3);
  END IF;
END $$;
NOTIFY pgrst, 'reload schema';
