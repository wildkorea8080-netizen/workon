-- =============================================================
-- 0028_agent_tiers_cleanup.sql
-- 옛 칸 제거 (S1-c)
--
-- **S1-c 코드가 배포되고 확인된 뒤에만 적용한다.** 옛 코드가 돌고 있는데
-- 적용하면 그 코드가 지워진 칸을 찾다 비서 조회가 멈춘다(0013의 교훈).
--
-- 지우는 것: agents.is_personal · agents.enabled_connectors, 그리고 0026이
-- 둘을 tier·capabilities와 맞추려고 둔 트리거·함수.
--
-- 남기는 것: 0026의 맞춤 트리거에는 옛 칸과 무관한 일이 하나 섞여 있었다 —
-- 대기(approval_status='pending')로 들어오는 순간의 판을 approval_version에
-- 찍는 것. 비면 승인이 판 확인을 건너뛰므로, 이 도장은 자기 트리거
-- (trg_agents_stamp_approval_version)로 옮겨 그대로 둔다.
--
-- 실DB에서 읽기 전용으로 확인한 두 칸의 의존 객체(2026-10-15):
--   - 뷰 v_organization_summary (0006) — is_personal을 쓴다. 칸을 지우기 전에
--     다시 만들어야 DROP COLUMN이 의존성 오류로 막히지 않는다
--   - 함수 agents_sync_legacy_columns (0026) — 아래에서 지운다
--   인덱스·제약·정책·다른 뷰·다른 함수는 없었다.
-- =============================================================

-- ── 1. 기관 현황 뷰를 tier로 다시 만든다 ─────────────────────
-- 0006 정의 그대로(실DB 정의와 일치 확인), current_agents 조건만 바뀐다.
-- 옛 조건 is_personal = false는 '나만의 비서가 아님'이었으므로 부서 비서도
-- 세었다. 같은 뜻을 tier <> 'personal'로 잇고, 지운 비서(0026 숨김)는 뺀다.
-- 열 이름·순서·형이 같아 CREATE OR REPLACE로 바꿀 수 있고 권한도 유지된다.
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

  -- 현재 비서 수 (나만의 비서·지운 비서 제외)
  (SELECT COUNT(*)
   FROM agents a
   JOIN departments d ON d.id = a.department_id
   WHERE d.organization_id = o.id
     AND a.tier <> 'personal'
     AND a.deleted_at IS NULL
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

-- ── 2. 옛 칸 맞춤 트리거·함수 ────────────────────────────────
DROP TRIGGER IF EXISTS trg_agents_sync_legacy ON agents;
DROP FUNCTION IF EXISTS agents_sync_legacy_columns();
DROP FUNCTION IF EXISTS agent_capability_connectors(jsonb);

-- ── 3. 승인 판 도장 — 맞춤 트리거에서 떼어 따로 남긴다 ────────
-- 0026 agents_sync_legacy_columns의 '승인 신청 ↔ 승인 판 번호' 부분 그대로.
CREATE OR REPLACE FUNCTION agents_stamp_approval_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- 승인 신청 ↔ 승인 판 번호
  -- 옛 신청 코드는 approval_status='pending'만 바꾼다. 판 번호가 비면 승인이
  -- 판 확인을 건너뛰므로, 대기로 들어오는 순간의 판을 신청 판으로 잡는다.
  IF NEW.approval_status = 'pending' AND NEW.approval_version IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      NEW.approval_version := NEW.version;
    ELSIF OLD.approval_status IS DISTINCT FROM 'pending' THEN
      NEW.approval_version := NEW.version;
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_agents_stamp_approval_version ON agents;
CREATE TRIGGER trg_agents_stamp_approval_version
  BEFORE INSERT OR UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION agents_stamp_approval_version();

-- ── 4. 옛 칸 ─────────────────────────────────────────────────
-- 0005의 owner 인덱스는 남는다. is_personal을 쓰던 인덱스는 없다.
ALTER TABLE agents
  DROP COLUMN IF EXISTS is_personal,
  DROP COLUMN IF EXISTS enabled_connectors;

-- ── 확인 ─────────────────────────────────────────────────────
SELECT column_name
  FROM information_schema.columns
 WHERE table_name = 'agents' AND column_name IN ('is_personal', 'enabled_connectors');
-- 0행이어야 한다

SELECT tgname
  FROM pg_trigger
 WHERE tgrelid = 'agents'::regclass AND tgname = 'trg_agents_stamp_approval_version';
-- 1행이어야 한다
