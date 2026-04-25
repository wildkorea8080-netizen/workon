-- =============================================================
-- 0007_impersonation.sql
-- 슈퍼관리자 대리 접근 감사 로그
-- =============================================================

CREATE TABLE IF NOT EXISTS impersonation_logs (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  super_admin_id uuid        NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  org_id         uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  target_user_id uuid        REFERENCES users(id) ON DELETE SET NULL,
  accessed_at    timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz,
  note           text,
  ip_address     text
);

CREATE INDEX IF NOT EXISTS idx_impers_super  ON impersonation_logs(super_admin_id);
CREATE INDEX IF NOT EXISTS idx_impers_org    ON impersonation_logs(org_id);
CREATE INDEX IF NOT EXISTS idx_impers_time   ON impersonation_logs(accessed_at);
