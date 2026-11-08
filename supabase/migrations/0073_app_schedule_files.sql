-- =============================================================
-- 0073_app_schedule_files.sql
-- 입력형 앱 예약에 '올린 파일'(src/lib/apps/schedule-files.ts)
--
-- 배경:
--   예약(0048)은 올린 파일을 받지 못했다 — 채팅 첨부는 한 대화에 묶이고, 보내지 않으면 24시간 뒤 정리된다.
--   파일이 필요한 앱은 문서함 문서(0062)를 고를 때만 예약할 수 있었다(비서 문서함이 없는 앱은 예약 불가).
--
-- 칸:
--   files — 예약이 따로 가진 파일 사본 목록. 원소는 { id, name, size, path }
--           (path = 저장소 documents 버킷의 `app-schedule-files/{기관}/{직원}/{id}.{확장자}`).
--           만들거나 고칠 때 직원의 읽힌 첨부를 이 경로로 복사하고, 실행 때마다 이 사본을 새 첨부로 다시 올려(직접 올리기와 같은
--           발급·확인 길) 그 실행의 대화에 붙인다. 예약을 지우거나 파일을 빼면 사본도 지운다. 기본은 빈 목록(지금과 같음).
--           3개까지(앱 파일 상한 APP_MAX_FILES와 같다 — 고른 문서와 합쳐 3개는 코드가 본다).
--
-- 추가만. 여러 번 적용해도 안전.
-- **코드 배포 전에 적용** — 새 코드가 예약 목록·만들기·고치기·실행에서 이 칸을 읽고 쓴다(없으면 예약 화면이 503).
-- =============================================================

ALTER TABLE app_schedules
  ADD COLUMN IF NOT EXISTS files jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_schedules_files_shape') THEN
    ALTER TABLE app_schedules ADD CONSTRAINT app_schedules_files_shape
      CHECK (jsonb_typeof(files) = 'array' AND jsonb_array_length(files) <= 3);
  END IF;
END $$;

COMMENT ON COLUMN app_schedules.files IS
  '예약이 가진 올린 파일 사본 [{id,name,size,path}] — 실행 때마다 새 첨부로 다시 올려 붙인다(0073)';

NOTIFY pgrst, 'reload schema';
