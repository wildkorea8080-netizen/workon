-- 0079: 입력형 앱 일괄 실행의 '파일마다 한 건'(2026-11-10) — 직원이 파일 여러 개(10개까지)를 올리면 파일 하나마다 줄 하나로 앱을 실행한다.
-- 줄은 그 파일의 사본(저장소 `app-batch-files/{기관}/{직원}/{id}.{확장자}`)을 가리키고, 실행기가 실행마다 사본을 새 첨부로 다시 붙인다
-- (예약의 올린 파일 0073과 같은 길 — src/lib/apps/batches.ts, docs/benchmarks/allganize/APP_BATCHES.md). 묶음이 끝나면 사본을 지운다.
-- 추가만(칸 하나). 여러 번 적용해도 안전. 코드 배포 전에 적용 — 새 코드의 실행기가 이 칸을 select 해, 없으면 일괄 실행이 돌지 않는다.
ALTER TABLE public.app_batch_items ADD COLUMN IF NOT EXISTS file jsonb;

ALTER TABLE public.app_batch_items DROP CONSTRAINT IF EXISTS app_batch_items_file_check;
ALTER TABLE public.app_batch_items ADD CONSTRAINT app_batch_items_file_check
  -- 빠진 키는 jsonb_typeof가 NULL이라 CHECK를 통과하므로 COALESCE로 막는다
  CHECK (file IS NULL OR (jsonb_typeof(file) = 'object' AND COALESCE(jsonb_typeof(file -> 'path'), '') = 'string' AND COALESCE(jsonb_typeof(file -> 'name'), '') = 'string'));

NOTIFY pgrst, 'reload schema';
