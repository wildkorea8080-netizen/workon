-- =============================================================
-- 0011_logs.sql
-- 접속 로그 + 시스템 로그 테이블
-- =============================================================

CREATE TABLE IF NOT EXISTS access_logs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        REFERENCES users(id) ON DELETE SET NULL,
  org_id      uuid        REFERENCES organizations(id) ON DELETE SET NULL,
  action      text        NOT NULL,
  path        text,
  ip_address  text,
  user_agent  text,
  status_code int,
  details     jsonb       NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_access_logs_user    ON access_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_access_logs_org     ON access_logs(org_id);
CREATE INDEX IF NOT EXISTS idx_access_logs_action  ON access_logs(action);
CREATE INDEX IF NOT EXISTS idx_access_logs_created ON access_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_logs_ip      ON access_logs(ip_address);

CREATE TABLE IF NOT EXISTS system_logs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  level       text        NOT NULL,
  category    text        NOT NULL,
  message     text        NOT NULL,
  details     jsonb       NOT NULL DEFAULT '{}',
  org_id      uuid        REFERENCES organizations(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_system_logs_level   ON system_logs(level);
CREATE INDEX IF NOT EXISTS idx_system_logs_cat     ON system_logs(category);
CREATE INDEX IF NOT EXISTS idx_system_logs_created ON system_logs(created_at DESC);

-- 확인
SELECT 'access_logs' AS tbl, COUNT(*) FROM access_logs
UNION ALL
SELECT 'system_logs', COUNT(*) FROM system_logs;
