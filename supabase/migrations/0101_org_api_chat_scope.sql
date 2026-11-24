-- 0101: 기관 API(0075)에 '비서에게 묻기' 범위 더하기(2026-11-24)
--
-- 기관 전체 관리자가 키를 만들 때 범위 'chat'(비서에게 묻기)을 고를 수 있게 org_api_keys.scopes CHECK를 넓히고,
-- 새 끝점 POST /api/v1/chat의 호출 기록을 받게 org_api_key_calls.endpoint CHECK에 'chat'을 더한다(src/lib/org-api/chat.ts).
-- 묻는 사람은 키를 만든 기관 전체 관리자 — 대화는 그 사람의 대화로 남고([API] 제목·conversations.metadata.org_api) 그 사람의 한도를 쓴다.
-- 값만 넓힘·여러 번 적용해도 안전. 0100 뒤에 적용. **코드 배포 전에 적용** — 없으면 'chat' 범위의 키 만들기가 CHECK에 걸려 실패한다.
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
  CHECK (cardinality(scopes) BETWEEN 1 AND 5 AND scopes <@ ARRAY['adoption', 'usage', 'documents', 'documents_write', 'chat']::text[]);

ALTER TABLE public.org_api_key_calls ADD CONSTRAINT org_api_key_calls_endpoint_check
  CHECK (endpoint IN ('adoption-report', 'adoption-departments', 'usage-summary', 'feedback-summary', 'app-runs', 'budget', 'documents',
                      'documents-upload-url', 'documents-create', 'chat'));
