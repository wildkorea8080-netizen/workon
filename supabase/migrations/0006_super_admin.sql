-- =============================================================
-- 0006_super_admin.sql
-- 슈퍼관리자(솔루션 운영자) 시스템 구축
-- 작성일: 2026-04-24
--
-- 변경 요약:
--   신규 테이블 4개: contracts, api_keys, billing_logs, super_admin_logs
--   기존 테이블 변경 4개: organizations, departments, users, usage_logs
--   뷰 2개: v_organization_summary, v_monthly_billing
--   함수 1개: aggregate_monthly_billing()
-- =============================================================


-- =============================================================
-- SECTION 1. 기존 테이블 컬럼 추가
-- =============================================================

-- ── 1-1. organizations: 계약/상태/제한 정보 추가 ──────────────
-- 현재: id, name, type, size, logo_url, created_at 만 존재

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS status          text        NOT NULL DEFAULT 'trial',
  -- 값: 'trial'(체험) | 'active'(정식) | 'suspended'(일시정지) | 'terminated'(해지)

  ADD COLUMN IF NOT EXISTS plan            text        NOT NULL DEFAULT 'trial',
  -- 값: 'trial' | 'basic' | 'standard' | 'enterprise'

  ADD COLUMN IF NOT EXISTS domain          text,
  -- 기관 도메인 (예: oads.or.kr) — 이메일 검증에 사용 가능

  ADD COLUMN IF NOT EXISTS contact_name    text,
  -- 담당자 이름

  ADD COLUMN IF NOT EXISTS contact_email   text,
  -- 담당자 이메일

  ADD COLUMN IF NOT EXISTS contact_phone   text,
  -- 담당자 연락처

  ADD COLUMN IF NOT EXISTS max_users       int         NOT NULL DEFAULT 20,
  -- 기관별 최대 사용자 수

  ADD COLUMN IF NOT EXISTS max_agents      int         NOT NULL DEFAULT 10,
  -- 기관별 최대 비서 수

  ADD COLUMN IF NOT EXISTS monthly_token_limit bigint  NOT NULL DEFAULT 2000000,
  -- 월별 토큰 한도 (기본 200만)

  ADD COLUMN IF NOT EXISTS notes           text,
  -- 운영자 메모

  ADD COLUMN IF NOT EXISTS updated_at      timestamptz NOT NULL DEFAULT now();

-- ── 1-2. departments: organization 연결 ───────────────────────
-- 현재 departments는 organizations와 연결되지 않아 멀티테넌트 계층 불완전

ALTER TABLE departments
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_departments_org ON departments(organization_id);

-- ── 1-3. users: 슈퍼관리자 플래그 추가 ───────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_super_admin  boolean     NOT NULL DEFAULT false;

-- ── 1-4. usage_logs: organization 단위 집계 지원 ─────────────
ALTER TABLE usage_logs
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_usage_logs_org ON usage_logs(organization_id);


-- =============================================================
-- SECTION 2. 신규 테이블
-- =============================================================

-- ── 2-1. contracts: 기관별 계약 관리 ─────────────────────────
CREATE TABLE IF NOT EXISTS contracts (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  plan                text        NOT NULL DEFAULT 'basic',
  -- 'trial' | 'basic' | 'standard' | 'enterprise'

  status              text        NOT NULL DEFAULT 'active',
  -- 'active' | 'expired' | 'cancelled' | 'pending'

  started_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz,
  -- null = 무기한

  max_users           int         NOT NULL DEFAULT 20,
  max_agents          int         NOT NULL DEFAULT 10,
  monthly_token_limit bigint      NOT NULL DEFAULT 2000000,

  price_per_month     numeric(10,2) NOT NULL DEFAULT 0,
  -- KRW 기준 월 요금

  auto_renew          boolean     NOT NULL DEFAULT true,

  signed_at           timestamptz,
  -- 계약서 서명일

  notes               text,
  -- 특이사항, 할인 조건 등

  created_by          uuid        REFERENCES users(id) ON DELETE SET NULL,
  -- 계약 등록한 슈퍼관리자

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contracts_org    ON contracts(organization_id);
CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(status);
CREATE INDEX IF NOT EXISTS idx_contracts_expire ON contracts(expires_at);

-- ── 2-2. api_keys: 기관별 API 키 독립 관리 ───────────────────
-- 시스템 기본 키(env) 외에 기관이 자체 키를 등록할 수 있음
-- key_value는 실제 운영 시 AES-256 등으로 암호화하여 저장 권장
CREATE TABLE IF NOT EXISTS api_keys (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  provider        text        NOT NULL,
  -- 'anthropic' | 'voyage' | 'openai'

  label           text        NOT NULL DEFAULT '기본 키',
  -- 식별용 이름 (예: "Anthropic 운영 키 2026")

  key_prefix      text,
  -- 앞 8자 (예: sk-ant-ap) — 화면 표시용

  key_value       text,
  -- 실제 키값 (암호화 저장 권장, 현재는 평문)
  -- null이면 시스템 env 키 사용

  is_active       boolean     NOT NULL DEFAULT true,
  is_default      boolean     NOT NULL DEFAULT false,
  -- 기관의 기본 키 (provider당 1개만 true)

  last_used_at    timestamptz,
  expires_at      timestamptz,

  created_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_org      ON api_keys(organization_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_provider ON api_keys(organization_id, provider);

-- provider당 기본 키는 1개만 허용
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_default
  ON api_keys(organization_id, provider)
  WHERE is_default = true AND is_active = true;

-- ── 2-3. billing_logs: 월별 기관 과금 집계 ───────────────────
CREATE TABLE IF NOT EXISTS billing_logs (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  period_year         int         NOT NULL,  -- 예: 2026
  period_month        int         NOT NULL,  -- 예: 4

  total_conversations int         NOT NULL DEFAULT 0,
  total_messages      int         NOT NULL DEFAULT 0,
  total_input_tokens  bigint      NOT NULL DEFAULT 0,
  total_output_tokens bigint      NOT NULL DEFAULT 0,
  total_tokens        bigint      GENERATED ALWAYS AS
                      (total_input_tokens + total_output_tokens) STORED,

  -- 비용 (plan 단가 × 토큰 수 기준, 또는 정액)
  token_cost_usd      numeric(10,4) NOT NULL DEFAULT 0,
  -- claude-sonnet-4-6 기준: input $3/M, output $15/M
  monthly_fee_krw     numeric(12,2) NOT NULL DEFAULT 0,
  -- 계약 월정액 (contracts.price_per_month 복사)

  status              text        NOT NULL DEFAULT 'draft',
  -- 'draft'(집계중) | 'finalized'(확정) | 'invoiced'(청구됨) | 'paid'(납부완료)

  finalized_at        timestamptz,
  notes               text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organization_id, period_year, period_month)
);

CREATE INDEX IF NOT EXISTS idx_billing_org    ON billing_logs(organization_id);
CREATE INDEX IF NOT EXISTS idx_billing_period ON billing_logs(period_year, period_month);
CREATE INDEX IF NOT EXISTS idx_billing_status ON billing_logs(status);

-- ── 2-4. super_admin_logs: 슈퍼관리자 조작 감사 로그 ─────────
CREATE TABLE IF NOT EXISTS super_admin_logs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id   uuid        NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  -- 작업한 슈퍼관리자

  action          text        NOT NULL,
  -- 'org_created' | 'org_suspended' | 'contract_updated' |
  -- 'api_key_rotated' | 'billing_finalized' | 'user_impersonated' 등

  target_type     text,
  -- 'organization' | 'contract' | 'api_key' | 'billing_log'

  target_id       uuid,
  -- 작업 대상 레코드 ID

  before_data     jsonb,
  -- 변경 전 스냅샷

  after_data      jsonb,
  -- 변경 후 스냅샷

  ip_address      text,
  user_agent      text,

  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_super_logs_admin  ON super_admin_logs(admin_user_id);
CREATE INDEX IF NOT EXISTS idx_super_logs_action ON super_admin_logs(action);
CREATE INDEX IF NOT EXISTS idx_super_logs_target ON super_admin_logs(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_super_logs_time   ON super_admin_logs(created_at);


-- =============================================================
-- SECTION 3. 뷰
-- =============================================================

-- ── 3-1. v_organization_summary: 기관별 현황 요약 ─────────────
CREATE OR REPLACE VIEW v_organization_summary AS
SELECT
  o.id,
  o.name,
  o.type,
  o.status,
  o.plan,
  o.domain,
  o.contact_name,
  o.contact_email,
  o.max_users,
  o.max_agents,
  o.monthly_token_limit,
  o.created_at,

  -- 계약 정보 (최신 active 계약)
  c.id            AS contract_id,
  c.expires_at    AS contract_expires_at,
  c.price_per_month,
  c.auto_renew,

  -- 현재 사용자 수
  (SELECT COUNT(*)
   FROM users u
   JOIN departments d ON d.id = u.department_id
   WHERE d.organization_id = o.id
  )               AS current_users,

  -- 현재 부서 수
  (SELECT COUNT(*)
   FROM departments d
   WHERE d.organization_id = o.id
  )               AS current_departments,

  -- 현재 비서 수 (공식 비서)
  (SELECT COUNT(*)
   FROM agents a
   JOIN departments d ON d.id = a.department_id
   WHERE d.organization_id = o.id
     AND a.is_personal = false
     AND a.is_active = true
  )               AS current_agents,

  -- 이번달 토큰 사용량
  (SELECT COALESCE(SUM((ul.details->>'input_tokens')::bigint +
                       (ul.details->>'output_tokens')::bigint), 0)
   FROM usage_logs ul
   WHERE ul.organization_id = o.id
     AND date_trunc('month', ul.created_at) = date_trunc('month', now())
  )               AS tokens_this_month

FROM organizations o
LEFT JOIN contracts c
  ON c.organization_id = o.id
  AND c.status = 'active'
  AND (c.expires_at IS NULL OR c.expires_at > now());

-- ── 3-2. v_monthly_billing: 월별 과금 요약 ───────────────────
CREATE OR REPLACE VIEW v_monthly_billing AS
SELECT
  bl.*,
  o.name          AS organization_name,
  o.plan          AS organization_plan,
  -- claude-sonnet-4-6 단가 추정: input $3/M tokens, output $15/M tokens
  ROUND(
    (bl.total_input_tokens::numeric  / 1000000 * 3) +
    (bl.total_output_tokens::numeric / 1000000 * 15),
    4
  )               AS estimated_cost_usd
FROM billing_logs bl
JOIN organizations o ON o.id = bl.organization_id;


-- =============================================================
-- SECTION 4. 월별 과금 집계 함수
-- =============================================================

CREATE OR REPLACE FUNCTION aggregate_monthly_billing(
  p_year  int DEFAULT EXTRACT(YEAR  FROM now())::int,
  p_month int DEFAULT EXTRACT(MONTH FROM now())::int
)
RETURNS TABLE (
  organization_id     uuid,
  organization_name   text,
  conversations       bigint,
  messages            bigint,
  input_tokens        bigint,
  output_tokens       bigint,
  estimated_cost_usd  numeric
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    o.id,
    o.name,
    COUNT(DISTINCT conv.id),
    COUNT(DISTINCT msg.id),
    COALESCE(SUM((ul.details->>'input_tokens')::bigint),  0),
    COALESCE(SUM((ul.details->>'output_tokens')::bigint), 0),
    ROUND(
      COALESCE(SUM((ul.details->>'input_tokens')::bigint),  0)::numeric / 1000000 * 3 +
      COALESCE(SUM((ul.details->>'output_tokens')::bigint), 0)::numeric / 1000000 * 15,
      4
    )
  FROM organizations o
  LEFT JOIN usage_logs ul
    ON ul.organization_id = o.id
   AND EXTRACT(YEAR  FROM ul.created_at) = p_year
   AND EXTRACT(MONTH FROM ul.created_at) = p_month
   AND ul.action = 'chat_message'
  LEFT JOIN conversations conv
    ON conv.id = ul.resource_id
  LEFT JOIN messages msg
    ON msg.conversation_id = conv.id
  GROUP BY o.id, o.name;
END;
$$;


-- =============================================================
-- SECTION 5. 초기 슈퍼관리자 계정 플래그 설정
-- =============================================================
-- 기존 ADMIN 계정 중 슈퍼관리자로 지정할 이메일 목록
-- (실제 운영 시 이 섹션만 수정하여 재실행)

UPDATE users
SET is_super_admin = true
WHERE email IN (
  'admin@welfare.org',
  'admin@researchcenter.kr'
  -- 추가 슈퍼관리자 이메일을 여기에 추가
);


-- =============================================================
-- SECTION 6. 기존 데이터 마이그레이션
-- =============================================================
-- 기존 departments를 organizations에 연결
-- 현재 organizations 테이블에 데이터가 있으면 자동 매핑,
-- 없으면 기관명 "기본 기관"을 생성하고 모든 부서에 연결

DO $$
DECLARE
  v_default_org_id uuid;
BEGIN
  -- 이미 organizations 데이터가 있으면 스킵
  IF EXISTS (SELECT 1 FROM organizations LIMIT 1) THEN
    -- 첫 번째 기관에 연결되지 않은 부서들을 첫 번째 기관으로 연결
    UPDATE departments
    SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
    WHERE organization_id IS NULL;

    RAISE NOTICE '기존 organizations 데이터에 departments 연결 완료';
    RETURN;
  END IF;

  -- organizations가 비어있으면 기본 기관 생성
  INSERT INTO organizations (name, type, status, plan)
  VALUES ('기본 기관', '공공기관', 'active', 'basic')
  RETURNING id INTO v_default_org_id;

  -- 모든 기존 부서를 기본 기관으로 연결
  UPDATE departments SET organization_id = v_default_org_id;

  RAISE NOTICE '기본 기관 생성 및 departments 연결 완료: %', v_default_org_id;
END $$;

-- usage_logs의 organization_id를 department 경유로 채우기
UPDATE usage_logs ul
SET organization_id = d.organization_id
FROM departments d
WHERE d.id = ul.department_id
  AND ul.organization_id IS NULL
  AND d.organization_id IS NOT NULL;


-- =============================================================
-- 확인 쿼리
-- =============================================================
SELECT
  '테이블 확인' AS check_type,
  table_name,
  COUNT(*) AS column_count
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
    'organizations', 'departments', 'users', 'contracts',
    'api_keys', 'billing_logs', 'super_admin_logs', 'usage_logs'
  )
GROUP BY table_name
ORDER BY table_name;
