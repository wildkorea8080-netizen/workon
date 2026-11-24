-- 0105: 기관 API '비서에게 묻기'(0101)의 첨부 끝점 둘 — 호출 기록 CHECK만 넓힌다(2026-11-24)
--
-- 기관 시스템이 묻기에 파일을 붙인다: POST /api/v1/chat/attachments/upload-url(주소) → PUT → POST /api/v1/chat/attachments(확인·읽기)
-- → POST /api/v1/chat { attachmentIds }. 범위는 그대로 'chat'(키 범위 CHECK는 바꾸지 않는다). 첨부는 화면 대화 첨부와 같은 표·함수.
-- 값만 넓힘·여러 번 적용해도 안전. 0104 뒤에 적용. 코드 배포 전이 좋다 — 없으면 첨부 호출은 돌고 호출 기록만 빠진다(기록 실패는 응답을 바꾸지 않는다).
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.org_api_key_calls'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%endpoint%'
  LOOP
    EXECUTE format('ALTER TABLE public.org_api_key_calls DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.org_api_key_calls ADD CONSTRAINT org_api_key_calls_endpoint_check
  CHECK (endpoint IN ('adoption-report', 'adoption-departments', 'usage-summary', 'feedback-summary', 'app-runs', 'budget', 'documents',
                      'documents-upload-url', 'documents-create', 'documents-delete', 'chat',
                      'chat-attachment-upload-url', 'chat-attachment-confirm'));
