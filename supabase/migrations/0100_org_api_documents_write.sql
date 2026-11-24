-- 0100: 기관 API(0075)에 문서 올리기 범위 더하기(2026-11-24)
--
-- 기관 전체 관리자가 키를 만들 때 범위 'documents_write'(문서 올리기·새 판 올리기)를 고를 수 있게 org_api_keys.scopes CHECK를 넓히고,
-- 새 끝점 POST /api/v1/documents/upload-url(올리기 주소)·POST /api/v1/documents(등록·읽기 시작)의 호출 기록을 받게
-- org_api_key_calls.endpoint CHECK에 'documents-upload-url'·'documents-create'를 더한다(src/lib/org-api/document-write.ts).
-- 올린 사람은 키를 만든 기관 전체 관리자, 나만의 비서에는 올리지 않고, 지우기는 API로 하지 않는다.
-- 값만 넓힘·여러 번 적용해도 안전. 0099 뒤에 적용. **코드 배포 전에 적용** — 없으면 'documents_write' 범위의 키 만들기가 CHECK에 걸려 실패한다.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.org_api_keys'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%scopes%'
  LOOP
    EXECUTE format('ALTER TABLE public.org_api_keys DROP CONSTRAINT %I', c.conname);
  END LOOP;
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.org_api_key_calls'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%endpoint%'
  LOOP
    EXECUTE format('ALTER TABLE public.org_api_key_calls DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.org_api_keys ADD CONSTRAINT org_api_keys_scopes_check
  CHECK (cardinality(scopes) BETWEEN 1 AND 4 AND scopes <@ ARRAY['adoption', 'usage', 'documents', 'documents_write']::text[]);

ALTER TABLE public.org_api_key_calls ADD CONSTRAINT org_api_key_calls_endpoint_check
  CHECK (endpoint IN ('adoption-report', 'adoption-departments', 'usage-summary', 'feedback-summary', 'app-runs', 'budget', 'documents',
                      'documents-upload-url', 'documents-create'));
