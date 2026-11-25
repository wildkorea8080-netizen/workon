-- 0120: 자료함 내용 글 채우기 표시 (2026-11-25)
--
-- 0117은 담을 때 그 파일을 글로 읽어 content_text에 두었다. 0117 전에 담은 파일과 담을 때 읽지 못한 파일(저장소가 잠깐 응답하지 않음 등)은
-- 내용 글이 없어 이름으로만 찾혔다. 5분 실행기(/api/cron/app-schedules)가 content_checked_at이 빈 파일을 몇 개씩 자료함 사본에서 다시 읽어
-- 채운다(src/lib/library-content-fill.ts). 읽었으면(글이 없었어도) 그때를 적어 다시 읽지 않고, 저장소가 잠깐 안 될 때만 다음 차례에 다시 본다.
-- 이미 내용 글이 있는 행은 담은 때로 채운다.
-- 추가만, 여러 번 적용해도 안전. **코드 배포 전에 적용** — 새 코드가 담기·보내기에서 이 칸을 쓰고 실행기가 읽어, 없으면 자료함 담기가 실패한다.

ALTER TABLE public.my_library_files
  ADD COLUMN IF NOT EXISTS content_checked_at timestamptz;

UPDATE public.my_library_files
   SET content_checked_at = created_at
 WHERE content_checked_at IS NULL AND content_text IS NOT NULL;

CREATE INDEX IF NOT EXISTS my_library_files_content_unchecked_idx
  ON public.my_library_files (created_at DESC)
  WHERE content_checked_at IS NULL;
