-- 0086: 기관 통계 읽기 API(0075)의 끝점 셋 더하기 — 호출 기록(org_api_key_calls.endpoint)의 CHECK만 넓힌다.
--
-- 새 끝점(2026-11-11): feedback-summary(답변 평가 요약)·app-runs(입력형 앱 실행 현황)·budget(예산 소진 현황) — 모두 범위 usage,
-- 관리자 통계 화면과 같은 읽기 함수로 숫자만 낸다(src/lib/org-api/reports.ts). 키의 범위(scopes)는 그대로다.
-- 값만 넓힘·여러 번 적용해도 안전. 코드 배포 전이 좋다 — 없으면 새 끝점 호출은 돌지만 호출 기록만 빠진다(기록 실패는 응답을 바꾸지 않음).
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
  CHECK (endpoint IN ('adoption-report', 'adoption-departments', 'usage-summary', 'feedback-summary', 'app-runs', 'budget'));
