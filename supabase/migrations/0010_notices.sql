-- =============================================================
-- 0010_notices.sql
-- 공지사항 + 시스템 설정 테이블
-- NOTE: super_admins 별도 테이블 없음 → users(id) 참조
-- =============================================================

CREATE TABLE IF NOT EXISTS notices (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text        NOT NULL,
  content         text        NOT NULL,
  importance      text        NOT NULL DEFAULT 'normal',
  -- 'normal' | 'important' | 'urgent'
  target_type     text        NOT NULL DEFAULT 'all',
  -- 'all' | 'specific'
  target_org_ids  uuid[]      NOT NULL DEFAULT '{}',
  is_published    boolean     NOT NULL DEFAULT false,
  published_at    timestamptz,
  expires_at      timestamptz,
  created_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notices_published ON notices(is_published, published_at);
CREATE INDEX IF NOT EXISTS idx_notices_importance ON notices(importance);

CREATE TABLE IF NOT EXISTS notice_reads (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_id  uuid        NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (notice_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_notice_reads_user ON notice_reads(user_id);

CREATE TABLE IF NOT EXISTS system_settings (
  key         text        PRIMARY KEY,
  value       text        NOT NULL,
  description text,
  updated_by  uuid        REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO system_settings (key, value, description) VALUES
  ('service_name',           'WORKON AI',                                    '서비스명'),
  ('service_url',            'https://workon-ai.vercel.app',                 '서비스 URL'),
  ('maintenance_mode',       'false',                                         '점검 모드'),
  ('maintenance_message',    '시스템 점검 중입니다. 잠시 후 다시 시도해주세요.', '점검 안내 메시지'),
  ('new_org_default_plan',   'trial',                                         '신규 기관 기본 플랜'),
  ('session_timeout_hours',  '24',                                            '세션 유지 시간(시간)'),
  ('max_file_size_mb',       '50',                                            '최대 파일 크기(MB)'),
  ('support_email',          'support@workon.ai',                             '고객지원 이메일'),
  ('max_login_attempts',     '5',                                             '로그인 실패 허용 횟수'),
  ('allowed_ips',            '0.0.0.0/0',                                     '슈퍼관리자 허용 IP')
ON CONFLICT (key) DO NOTHING;

-- 확인
SELECT key, value, description FROM system_settings ORDER BY key;
