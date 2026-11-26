-- 0135: 기관 예산 알림을 더 받을 사람 (src/lib/budget-alerts.ts · /api/admin/budget-alerts)
--
-- 기관 예산 알림(0045)은 기관 담당자 메일과 최상위 부서 관리자에게만 갔다 — 예산을 집행·증액하는 예산 담당자가 관리자가 아니면 받지 못했다.
-- 기관 전체 관리자가 주소를 5개까지 더한다. 기관 알림(연간 정액 예산·월 토큰 한도)에만 더한다(부서 알림은 그 부서 관리자 그대로).
-- 추가만, 여러 번 적용해도 안전. 코드 배포 전에 적용 — 새 코드가 알림 받는 사람·설정 화면에서 이 칸을 읽어, 없으면 기관 예산 알림이 실패로 남고 다음 날 다시 해 본다.
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS budget_alert_emails text[] NOT NULL DEFAULT '{}';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_budget_alert_emails_count') THEN
    ALTER TABLE public.organizations ADD CONSTRAINT organizations_budget_alert_emails_count CHECK (cardinality(budget_alert_emails) <= 5);
  END IF;
END $$;
NOTIFY pgrst, 'reload schema';
