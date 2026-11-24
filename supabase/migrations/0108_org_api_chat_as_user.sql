-- 0108: 기관 API '직원으로 묻기' 범위 더하기(2026-11-25)
--
-- 기관 전체 관리자가 키를 만들 때 범위 'chat_as_user'(비서에게 묻기와 함께)를 고를 수 있게 org_api_keys.scopes CHECK를 넓힌다.
-- 이 범위의 키는 POST /api/v1/chat·/api/v1/chat/attachments(…)에 asUser(직원 이메일)를 실어 그 직원의 권한·한도·대화로 묻는다
-- (src/lib/org-api/as-user.ts — 이 기관에 등록된 쓸 수 있는 직원만, 계정을 만들지 않음). 끝점은 그대로라 호출 기록 CHECK는 바꾸지 않는다.
-- 값만 넓힘·여러 번 적용해도 안전. 0104 뒤에 적용. **코드 배포 전에 적용** — 없으면 'chat_as_user' 범위의 키 만들기가 CHECK에 걸려 실패한다.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.org_api_keys'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%scopes%'
  LOOP
    EXECUTE format('ALTER TABLE public.org_api_keys DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.org_api_keys ADD CONSTRAINT org_api_keys_scopes_check
  CHECK (cardinality(scopes) BETWEEN 1 AND 7 AND scopes <@ ARRAY['adoption', 'usage', 'documents', 'documents_write', 'documents_delete', 'chat', 'chat_as_user']::text[]);
