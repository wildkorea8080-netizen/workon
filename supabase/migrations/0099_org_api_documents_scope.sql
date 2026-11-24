-- 0099: 기관 API(0075)에 문서함 목록 범위 더하기(2026-11-23)
--
-- 기관 전체 관리자가 키를 만들 때 범위 'documents'(문서함 현황)를 고를 수 있게 org_api_keys.scopes CHECK를 넓히고,
-- 새 끝점 GET /api/v1/documents의 호출 기록을 받게 org_api_key_calls.endpoint CHECK에 'documents'를 더한다.
-- 끝점은 문서 이름·비서·읽기 상태·판·시행일·태그만 낸다(본문·원본·저장소 경로 없음, 나만의 비서 문서 제외 — src/lib/org-api/documents.ts).
-- 값만 넓힘·여러 번 적용해도 안전. **코드 배포 전에 적용** — 없으면 'documents' 범위의 키 만들기가 CHECK에 걸려 실패한다(다른 범위·끝점은 그대로).
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
  CHECK (cardinality(scopes) BETWEEN 1 AND 3 AND scopes <@ ARRAY['adoption', 'usage', 'documents']::text[]);

ALTER TABLE public.org_api_key_calls ADD CONSTRAINT org_api_key_calls_endpoint_check
  CHECK (endpoint IN ('adoption-report', 'adoption-departments', 'usage-summary', 'feedback-summary', 'app-runs', 'budget', 'documents'));
