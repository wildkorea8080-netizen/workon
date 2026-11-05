-- 0061: 기관 태그 분류표 (src/lib/document-tags.ts · src/lib/document-tag-vocabulary.ts, /api/documents/tag-vocabulary)
--
-- 0060의 문서 태그는 사람마다 표기가 달라지기 쉽다('여비'·'출장여비'·'여비규정'). 기관 전체 관리자가 기관의 태그 목록(분류표)을 정하면
-- 태그를 붙일 때·AI 초안이 그 표기를 먼저 쓰고, '분류표의 태그만 쓰기'를 켜면 분류표에 없는 태그는 저장하지 못한다.
-- 기관마다 한 행. 태그는 100개까지(한 태그 20자 규칙은 앱이 본다). 켜기는 분류표가 비어 있지 않을 때만.
-- 추가만(기존 표 무변경). 여러 번 적용해도 안전. RLS 켜고 정책 없음(서비스 키만).
-- 코드 배포 전에 반드시 적용 — 태그 저장(PATCH /api/documents/[id])이 분류표를 읽어, 없으면 태그 저장이 실패한다.
CREATE TABLE IF NOT EXISTS public.document_tag_vocabularies (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  tags text[] NOT NULL DEFAULT '{}',
  restricted boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_tag_vocabularies_count CHECK (cardinality(tags) <= 100),
  CONSTRAINT document_tag_vocabularies_restricted_nonempty CHECK (NOT restricted OR cardinality(tags) > 0)
);
ALTER TABLE public.document_tag_vocabularies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.document_tag_vocabularies FROM anon, authenticated;
NOTIFY pgrst, 'reload schema';
