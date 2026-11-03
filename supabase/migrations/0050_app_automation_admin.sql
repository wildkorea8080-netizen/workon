-- 앱 예약·연동 관리자 통제 — 기관 관리자가 관리 범위 직원의 연동을 회수하고 예약을 멈출 수 있게 한다
-- (src/lib/apps/automation-admin.ts, docs/benchmarks/allganize/APP_AUTOMATION_ADMIN.md).
-- 추가만(칸 둘·CHECK 둘). 여러 번 적용해도 안전. **코드 배포 전에 적용** — 새 코드가 이 칸을 읽는다.

-- 연동을 회수한 까닭. 직원이 스스로 회수하면 비고, 관리자 회수·계정 탈퇴는 문장이 남는다(직원 화면에 보인다)
ALTER TABLE public.app_webhooks ADD COLUMN IF NOT EXISTS revoked_reason text;
DO $$ BEGIN
  ALTER TABLE public.app_webhooks ADD CONSTRAINT app_webhooks_revoked_reason_check
    CHECK (revoked_reason IS NULL OR (status = 'revoked' AND char_length(revoked_reason) BETWEEN 1 AND 300));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 관리자가 멈춘 때. 비어 있지 않으면 직원이 다시 켜지 못한다(관리자가 잠금을 풀어야 한다). 켜진 예약에는 있을 수 없다
ALTER TABLE public.app_schedules ADD COLUMN IF NOT EXISTS admin_paused_at timestamptz;
DO $$ BEGIN
  ALTER TABLE public.app_schedules ADD CONSTRAINT app_schedules_admin_paused_check
    CHECK (admin_paused_at IS NULL OR status = 'paused');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 관리자 목록은 기관·부서로 고른다
CREATE INDEX IF NOT EXISTS app_webhooks_org_dept_idx ON public.app_webhooks (organization_id, department_id);
CREATE INDEX IF NOT EXISTS app_schedules_org_dept_idx ON public.app_schedules (organization_id, department_id);
