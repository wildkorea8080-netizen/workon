-- =============================================================
-- BM-01: WORKON 벤치마킹 기능 DB 마이그레이션
-- 작성일: 2026-04-22
-- 대상: agents, users, conversations 컬럼 추가
--       invitations, organizations 테이블 신규 생성
-- =============================================================

-- ─────────────────────────────────────────────
-- 1. agents 테이블 컬럼 추가
-- ─────────────────────────────────────────────

-- 비서 카테고리 (BM-05 카테고리 탭에서 사용)
-- 값: '전체', '공공기관', '업무', '문서', '번역', '내비서'
ALTER TABLE agents ADD COLUMN IF NOT EXISTS
  category text DEFAULT '전체';

-- 나만의 비서 여부 (BM-04 개인 비서 기능에서 사용)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS
  is_personal boolean DEFAULT false;

-- 나만의 비서 소유자 (is_personal=true 일 때 유효)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS
  owner_id uuid REFERENCES users(id) ON DELETE CASCADE;

-- 공식 비서 등록 신청 상태 (BM-08 승인 흐름에서 사용)
-- 값: null(기본 공용), 'pending'(신청 중), 'approved'(승인), 'rejected'(반려)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS
  approval_status text DEFAULT null;

-- 승인/반려 시 관리자 메모
ALTER TABLE agents ADD COLUMN IF NOT EXISTS
  approval_note text;

-- ─────────────────────────────────────────────
-- 2. users 테이블 컬럼 추가
-- ─────────────────────────────────────────────

-- 즐겨찾기 비서 ID 배열 (BM-05 즐겨찾기 기능에서 사용)
ALTER TABLE users ADD COLUMN IF NOT EXISTS
  favorite_agent_ids uuid[] DEFAULT '{}';

-- 온보딩 완료 여부 (최초 로그인 가이드 표시 여부)
ALTER TABLE users ADD COLUMN IF NOT EXISTS
  onboarding_completed boolean DEFAULT false;

-- 직책 (조직도/사용자 목록 표시용)
ALTER TABLE users ADD COLUMN IF NOT EXISTS
  position text;

-- ─────────────────────────────────────────────
-- 3. conversations 테이블 컬럼 추가
-- ─────────────────────────────────────────────

-- 대화 공유 토큰 (BM-09 대화 공유 기능에서 사용)
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS
  share_token text UNIQUE;

-- 공유 활성화 여부
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS
  is_shared boolean DEFAULT false;

-- ─────────────────────────────────────────────
-- 4. invitations 테이블 신규 생성 (BM-03 초대 기반 가입)
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS invitations (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text        NOT NULL,
  department_id uuid       REFERENCES departments(id) ON DELETE CASCADE,
  role         text        NOT NULL DEFAULT 'USER',
  token        text        UNIQUE NOT NULL,
  invited_by   uuid        REFERENCES users(id) ON DELETE SET NULL,
  expires_at   timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────
-- 5. organizations 테이블 신규 생성 (BM-12 공공기관 디자인)
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  type       text,
  -- 예: '중앙행정기관', '지방자치단체', '공기업', '준정부기관', '민간'
  size       text,
  -- 예: 'small'(<50), 'medium'(50~300), 'large'(300+)
  logo_url   text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL;

-- ─────────────────────────────────────────────
-- 6. 인덱스 추가
-- ─────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_agents_category    ON agents(category);
CREATE INDEX IF NOT EXISTS idx_agents_owner       ON agents(owner_id);
CREATE INDEX IF NOT EXISTS idx_agents_approval    ON agents(approval_status);
CREATE INDEX IF NOT EXISTS idx_invitations_token  ON invitations(token);
CREATE INDEX IF NOT EXISTS idx_invitations_email  ON invitations(email);
CREATE INDEX IF NOT EXISTS idx_invitations_dept   ON invitations(department_id);
