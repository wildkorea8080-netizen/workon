-- 0117: 자료함 파일 내용 찾기 (2026-11-25)
--
-- 내 자료함·부서·기관·공유 자료함(0103·0106·0112·0116)의 찾기는 파일 이름만 봤다. 담을 때 그 파일을 글로 읽은 것
-- (대화 첨부는 이미 읽어 둔 내용, 비서가 만든 파일은 원본을 다시 읽음 — 스캔 PDF는 NODA로 보내지 않음)을 앞 20,000자까지
-- content_text에 두고, 찾기는 이름 + 내용을 이은 search_text(생성 칸)를 본다. 다른 자료함으로 복사·옮기면 함께 간다.
-- - content_text: 다듬은 글(제어·서식 글자 빼고 공백 하나로), 20,000자까지. 읽지 못했거나 글이 없거나 0117 전에 담은 파일은 NULL(이름으로만 찾힘).
-- - search_text: file_name || ' ' || content_text — 코드가 쓰지 않는다(생성 칸). 이름을 바꾸면 따라 바뀐다.
-- 추가만, 여러 번 적용해도 안전. **코드 배포 전에 반드시 적용** — 새 코드가 담기·보내기에서 content_text를 쓰고 찾기에서 search_text를 읽어,
-- 없으면 자료함 담기·찾기가 실패한다.

ALTER TABLE public.my_library_files
  ADD COLUMN IF NOT EXISTS content_text text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'my_library_files_content_text_check') THEN
    ALTER TABLE public.my_library_files
      ADD CONSTRAINT my_library_files_content_text_check CHECK (content_text IS NULL OR char_length(content_text) BETWEEN 1 AND 20000);
  END IF;
END $$;

ALTER TABLE public.my_library_files
  ADD COLUMN IF NOT EXISTS search_text text GENERATED ALWAYS AS (file_name || ' ' || coalesce(content_text, '')) STORED;
