-- 사용자 활성화 여부 컬럼 추가
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

-- 비밀번호 컬럼 (슈퍼관리자 비밀번호 변경 API용)
-- Supabase Auth가 관리하므로 users 테이블에는 별도 저장 안 함
-- 확인용 쿼리
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'users'
ORDER BY ordinal_position;
