-- api_keys 테이블의 organization_id를 nullable로 변경
-- NULL = 시스템 기본 키 (전체 기관 공용)
ALTER TABLE api_keys ALTER COLUMN organization_id DROP NOT NULL;

-- 시스템 기본 키 전용 인덱스
CREATE INDEX IF NOT EXISTS idx_api_keys_system ON api_keys(provider)
  WHERE organization_id IS NULL;
