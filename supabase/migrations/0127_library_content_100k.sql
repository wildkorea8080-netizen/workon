-- 0127: 자료함 내용 찾기 100,000자(2026-11-26) — src/lib/my-library-spec.ts, docs/benchmarks/allganize/MY_LIBRARY.md
-- 0117은 담을 때 읽은 글의 앞 20,000자만 두어 긴 보고서·규정집의 뒷부분 낱말로는 찾지 못했다. 첨부 읽개는 200,000자까지 읽으므로
-- 담아 둘 글을 100,000자까지 넓힌다(찾기는 그대로 이름 + 내용 search_text). 20,000자에서 잘렸을 파일은 '아직 확인 안 함'으로 돌려
-- 5분 실행기(0120 `fillLibraryContent`)가 자료함 사본에서 다시 읽어 채우게 한다.
-- 값만 넓힘·여러 번 적용해도 안전. **코드 배포 전에 적용** — 새 코드가 20,000자 넘는 글을 담으면 옛 CHECK가 담기를 거절한다.

ALTER TABLE public.my_library_files DROP CONSTRAINT IF EXISTS my_library_files_content_text_check;
ALTER TABLE public.my_library_files
  ADD CONSTRAINT my_library_files_content_text_check CHECK (content_text IS NULL OR char_length(content_text) BETWEEN 1 AND 100000);

-- 20,000자 상한에 닿아 잘렸을 파일(다듬어 끝 공백을 뗀 몫까지) — 다시 읽게
UPDATE public.my_library_files
  SET content_checked_at = NULL
  WHERE content_text IS NOT NULL AND char_length(content_text) BETWEEN 19990 AND 20000;

NOTIFY pgrst, 'reload schema';
