-- 0062: 입력형 앱 예약에 '문서함에서 고른 문서' (src/lib/apps/schedules.ts · library-documents.ts `currentEditionIds`)
--
-- 예약(0048)은 파일 입력을 받지 못했다(첨부는 한 대화에 묶이고 서명 주소가 짧다). 문서함 문서는 그 앱 비서에 올려 둔 참고 문서라
-- id로 저장해 두고 실행 때마다 다시 읽을 수 있다. 저장한 문서에 새 판이 나와 근거가 되면 실행은 새 판을 쓴다(판 사슬 replaces_id).
-- 3개까지(앱 파일 상한 APP_MAX_FILES와 같다). 외래 키는 두지 않는다 — 지워진 문서는 실행 때 알아보고 예약을 멈춘다.
-- 추가만, 여러 번 적용해도 안전. 코드 배포 전에 적용 — 예약 목록·만들기가 이 칸을 select 해, 없으면 앱 예약 화면이 503이다.
ALTER TABLE public.app_schedules ADD COLUMN IF NOT EXISTS document_ids uuid[] NOT NULL DEFAULT '{}';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_schedules_document_ids_count') THEN
    ALTER TABLE public.app_schedules ADD CONSTRAINT app_schedules_document_ids_count CHECK (cardinality(document_ids) <= 3);
  END IF;
END $$;
NOTIFY pgrst, 'reload schema';
