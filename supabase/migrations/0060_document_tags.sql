-- 0060: 비서 문서의 태그 (src/lib/document-tags.ts, PATCH /api/documents/[id])
--
-- 관리자 문서 목록에 검색·거르기가 없어 문서가 많아지면 찾기 어려웠다. 문서에 사람이 붙이는 태그(분류)를 둔다.
-- 태그는 행마다다(같은 원본을 다른 비서에 붙이면 붙일 때 태그를 함께 옮긴다 — 붙인 뒤에는 따로). AI 태그 초안은 아직 없다.
-- 태그 글의 다듬기·길이(20자)는 앱(normalizeDocumentTags)이 보고, DB는 개수(10개)만 막는다.
-- 추가만(기존 행은 빈 배열). 여러 번 적용해도 안전.
-- **코드 배포 전에 반드시 적용** — 문서 목록(GET /api/documents)이 이 칸을 select 해, 없으면 문서 화면이 목록을 못 읽는다.
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_tags_count') THEN
    ALTER TABLE public.documents ADD CONSTRAINT documents_tags_count CHECK (cardinality(tags) <= 10);
  END IF;
END $$;
NOTIFY pgrst, 'reload schema';
