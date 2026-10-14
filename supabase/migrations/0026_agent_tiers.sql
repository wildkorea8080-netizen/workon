-- =============================================================
-- 0026_agent_tiers.sql
-- 비서 단계(나만의·부서·공식) · 판 기록 · 능력 · 양식 자리 (S1-a)
--
-- 설계: docs/superpowers/specs/2026-10-14-s1-agent-structure-and-executor-design.md
--
-- 배포 순서: 이 파일 → S1-a 코드 → (S1-c 끝) 0027에서 옛 칸 제거.
-- 옛 코드가 is_personal · enabled_connectors만 써도 tier · capabilities가
-- 따라가도록 트리거로 맞춘다. 반대 방향도 맞춘다 — S1-b 전까지 대화
-- 코드는 enabled_connectors를 읽는다.
-- =============================================================


-- ── 1. agents 칸 ──────────────────────────────────────────────
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS tier text,
  ADD COLUMN IF NOT EXISTS model_id text,
  ADD COLUMN IF NOT EXISTS capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS approval_version integer,
  ADD COLUMN IF NOT EXISTS approval_requested_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- tier에는 DEFAULT를 두지 않는다. 기본값이 있으면 옛 코드가 is_personal=true로
-- 만든 행에 'official'이 먼저 들어가 트리거가 구분할 수 없다.
UPDATE agents
   SET tier = CASE WHEN COALESCE(is_personal, false) THEN 'personal' ELSE 'official' END
 WHERE tier IS NULL;

ALTER TABLE agents ALTER COLUMN tier SET NOT NULL;

-- 이미 승인 대기 중인 신청에 신청 당시 판을 채운다. 비어 있으면 승인할 때
-- "신청한 판 그대로인가"를 확인할 근거가 없어, 신청 뒤 고친 내용이 그대로
-- 공식 비서가 된다. (배포 사이 옛 신청 코드가 남기는 신청은 아래 트리거가 채운다.)
UPDATE agents SET approval_version = version
 WHERE approval_status = 'pending' AND approval_version IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_tier_check') THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_tier_check CHECK (tier IN ('personal', 'department', 'official'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_department_tier_visibility_check') THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_department_tier_visibility_check
      CHECK (tier <> 'department' OR visibility = 'department');
  END IF;
END $$;

COMMENT ON COLUMN agents.tier IS
  '단계의 유일한 근거. personal=본인만, department=주인 부서와 하위 부서가 쓰고 주인 부서원이 고침, official=관리자가 고침.';
COMMENT ON COLUMN agents.model_id IS '이 비서의 모델. NULL이면 기관 기본 모델.';
COMMENT ON COLUMN agents.capabilities IS
  '켜진 능력과 설정. 예: {"public_data":{"connectors":["law"]},"image":{}}. 정규화는 src/lib/capabilities/settings.ts.';
COMMENT ON COLUMN agents.version IS '현재 판 번호. save_agent만 올린다.';
COMMENT ON COLUMN agents.deleted_at IS
  '지운 시각. 행을 지우지 않는 이유: 대화(conversations.agent_id)와 판 기록이 이 비서를 가리킨다.';


-- ── 2. 능력 옮기기 ────────────────────────────────────────────
-- 지금 동작을 그대로 옮긴다: 대화형은 모두 사진을 받고, 문서가 있으면
-- 검색하고, 커넥터가 켜져 있으면 공공데이터를 조회한다.
UPDATE agents a
   SET capabilities = jsonb_strip_nulls(jsonb_build_object(
         'image',       CASE WHEN a.agent_type = 'chat' THEN '{}'::jsonb END,
         'doc_search',  CASE WHEN EXISTS (SELECT 1 FROM documents d WHERE d.agent_id = a.id)
                            THEN '{}'::jsonb END,
         'public_data', CASE WHEN COALESCE(cardinality(a.enabled_connectors), 0) > 0
                            THEN jsonb_build_object('connectors', to_jsonb(a.enabled_connectors)) END))
 WHERE a.capabilities = '{}'::jsonb;


-- ── 3. 이름 유일성 ────────────────────────────────────────────
-- 예전 인덱스는 (department_id, name) 하나라, 같은 부서 직원 둘이 같은
-- 이름의 나만의 비서를 만들 수 없었다. 나만의 비서는 본인 안에서만 겹치지
-- 않으면 된다. 지운 비서는 이름을 놓아준다.
DROP INDEX IF EXISTS agents_department_name_idx;

-- 예전 유일성은 부서 단위라, 같은 사람이 부서를 옮기며 같은 이름의 나만의
-- 비서를 둘 가질 수 있었다. 그대로 두면 아래 인덱스 생성이 실패해 마이그레이션
-- 전체가 멈춘다. 먼저 만든 것은 그대로 두고 두 번째부터 ' (2)', ' (3)'을 붙인다.
-- owner_id가 NULL인 행은 인덱스가 겹침으로 보지 않으므로 건드리지 않는다.
-- 바꾼 목록은 맨 끝 확인 쿼리에서 센다.
CREATE TEMP TABLE IF NOT EXISTS _0026_personal_renamed (
  agent_id uuid, old_name text, new_name text
) ON COMMIT DROP;

WITH ranked AS (
  SELECT id, name,
         row_number() OVER (PARTITION BY owner_id, name
                            ORDER BY created_at, id) AS n
    FROM agents
   WHERE tier = 'personal' AND deleted_at IS NULL AND owner_id IS NOT NULL
), renamed AS (
  UPDATE agents a
     SET name = r.name || ' (' || r.n || ')'
    FROM ranked r
   WHERE a.id = r.id AND r.n > 1
  RETURNING a.id, r.name AS old_name, a.name AS new_name
)
INSERT INTO _0026_personal_renamed (agent_id, old_name, new_name)
SELECT id, old_name, new_name FROM renamed;

CREATE UNIQUE INDEX IF NOT EXISTS agents_shared_name_idx
  ON agents(department_id, name) WHERE tier <> 'personal' AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agents_personal_name_idx
  ON agents(owner_id, name) WHERE tier = 'personal' AND deleted_at IS NULL;


-- ── 4. 옛 칸 맞춤 트리거 (0027에서 제거) ─────────────────────
CREATE OR REPLACE FUNCTION agent_capability_connectors(caps jsonb)
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(caps -> 'public_data' -> 'connectors', '[]'::jsonb))),
    '{}'::text[])
$$;

CREATE OR REPLACE FUNCTION agents_sync_legacy_columns()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- 단계 ↔ is_personal
  IF TG_OP = 'INSERT' THEN
    IF NEW.tier IS NULL THEN
      NEW.tier := CASE WHEN COALESCE(NEW.is_personal, false) THEN 'personal' ELSE 'official' END;
    END IF;
  ELSIF NEW.tier IS NOT DISTINCT FROM OLD.tier AND NEW.is_personal IS DISTINCT FROM OLD.is_personal THEN
    -- 옛 승인 코드는 is_personal=false만 바꾼다
    NEW.tier := CASE WHEN COALESCE(NEW.is_personal, false) THEN 'personal' ELSE 'official' END;
  END IF;
  NEW.is_personal := (NEW.tier = 'personal');

  -- 능력 ↔ enabled_connectors
  IF TG_OP = 'INSERT' THEN
    IF NEW.capabilities = '{}'::jsonb THEN
      -- 능력을 모르는 옛 코드의 생성. 지금 동작(사진 + 켠 커넥터)으로 채운다.
      NEW.capabilities := jsonb_strip_nulls(jsonb_build_object(
        'image',       CASE WHEN COALESCE(NEW.agent_type, 'chat') = 'chat' THEN '{}'::jsonb END,
        'public_data', CASE WHEN COALESCE(cardinality(NEW.enabled_connectors), 0) > 0
                            THEN jsonb_build_object('connectors', to_jsonb(NEW.enabled_connectors)) END));
    END IF;
    NEW.enabled_connectors := agent_capability_connectors(NEW.capabilities);
  ELSIF NEW.capabilities IS DISTINCT FROM OLD.capabilities THEN
    NEW.enabled_connectors := agent_capability_connectors(NEW.capabilities);
  ELSIF NEW.enabled_connectors IS DISTINCT FROM OLD.enabled_connectors THEN
    NEW.capabilities := CASE
      WHEN COALESCE(cardinality(NEW.enabled_connectors), 0) > 0
        THEN NEW.capabilities || jsonb_build_object('public_data',
               jsonb_build_object('connectors', to_jsonb(NEW.enabled_connectors)))
      ELSE NEW.capabilities - 'public_data'
    END;
  END IF;

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

DROP TRIGGER IF EXISTS trg_agents_sync_legacy ON agents;
CREATE TRIGGER trg_agents_sync_legacy
  BEFORE INSERT OR UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION agents_sync_legacy_columns();


-- ── 5. 양식 파일 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
  storage_path text NOT NULL,
  file_name    text NOT NULL,
  mime_type    text,
  size_bytes   integer NOT NULL CHECK (size_bytes >= 0),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- 새 행은 꺼진 채로 들어간다. save_agent가 판을 올리며 켠다 — 그래야
  -- 양식 추가도 판 사본에 남고 되돌리기 대상이 된다. 교체·제거도 행과
  -- 파일을 지우지 않고 여기만 찍는다.
  retired_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_templates_active
  ON agent_templates(agent_id) WHERE retired_at IS NULL;

COMMENT ON TABLE agent_templates IS
  '비서의 양식 파일(HWP·HWPX·DOCX). 쓰는 중인 것은 비서당 10개. 채우는 일은 S2.';


-- ── 6. 판 기록 ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_history (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN (
               'created', 'migrated', 'settings', 'revert', 'preset_update',
               'tier', 'document_added', 'document_removed', 'deleted')),
  version    integer,
  snapshot   jsonb,
  changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- 판 번호가 있는 종류만 사본을 갖는다
  CONSTRAINT agent_history_version_snapshot_check CHECK (
    (kind IN ('created', 'migrated', 'settings', 'revert', 'preset_update'))
      = (version IS NOT NULL AND snapshot IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_history_version_idx
  ON agent_history(agent_id, version) WHERE version IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_history_agent_idx
  ON agent_history(agent_id, created_at DESC);

COMMENT ON TABLE agent_history IS
  '비서 타임라인. 설정 판(사본 포함) · 단계 변경 · 참고 문서 올림/지움 · 지움.';


-- ── 7. 메시지에 판 번호 ───────────────────────────────────────
ALTER TABLE messages ADD COLUMN IF NOT EXISTS agent_version integer;
COMMENT ON COLUMN messages.agent_version IS
  '이 답을 만든 비서의 판 번호. 감사에서 "그때 어떤 지시문으로 답했나"에 답한다.';


-- ── 8. 판 사본 ────────────────────────────────────────────────
-- 사본에 담는 칸은 이 함수 한 곳에서 정한다.
CREATE OR REPLACE FUNCTION agent_snapshot(a agents)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'name',            a.name,
    'description',     a.description,
    'icon',            a.icon,
    'color',           a.color,
    'category',        a.category,
    'usage_guide',     a.usage_guide,
    'starter_prompts', to_jsonb(a.starter_prompts),
    'system_prompt',   a.system_prompt,
    'model_id',        a.model_id,
    'capabilities',    a.capabilities,
    'template_ids',    COALESCE(
                         -- 같은 시각에 만든 양식도 순서가 흔들리지 않게 id로 한 번 더 정렬
                         (SELECT jsonb_agg(t.id ORDER BY t.created_at, t.id)
                            FROM agent_templates t
                           WHERE t.agent_id = a.id AND t.retired_at IS NULL),
                         '[]'::jsonb))
$$;


-- ── 9. 기존 비서에 판 1 ───────────────────────────────────────
INSERT INTO agent_history (agent_id, kind, version, snapshot, changed_by, detail)
SELECT a.id, 'migrated', a.version, agent_snapshot(a), NULL,
       jsonb_build_object('note', '0026 이전 데이터')
  FROM agents a
 WHERE NOT EXISTS (
         SELECT 1 FROM agent_history h WHERE h.agent_id = a.id AND h.version = a.version);


-- ── 10. 새 비서는 판 1을 자동으로 ─────────────────────────────
-- 만드는 경로가 여럿이다(관리자 생성, 나만의 비서, 기본 비서 설치, 옛 코드).
-- 경로마다 기록 코드를 두면 하나는 빠진다.
CREATE OR REPLACE FUNCTION agents_record_created()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO agent_history (agent_id, kind, version, snapshot, changed_by)
  VALUES (NEW.id, 'created', NEW.version, agent_snapshot(NEW), NEW.created_by);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_agents_record_created ON agents;
CREATE TRIGGER trg_agents_record_created
  AFTER INSERT ON agents
  FOR EACH ROW EXECUTE FUNCTION agents_record_created();


-- ── 11. save_agent ────────────────────────────────────────────
-- 저장 · 판 번호 올리기 · 판 기록을 한 번에 한다. 권한은 호출 전에
-- 애플리케이션(agent-permissions.ts)이 판정한다 — 이 함수는 판의
-- 무결성만 책임진다.
CREATE OR REPLACE FUNCTION save_agent(
  p_agent_id     uuid,
  p_base_version integer,
  p_patch        jsonb,
  p_actor        uuid,
  p_kind         text,
  p_detail       jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  cur          agents%ROWTYPE;
  saved        agents%ROWTYPE;
  before_snap  jsonb;
  after_snap   jsonb;
  active_count integer;
BEGIN
  IF p_kind NOT IN ('settings', 'revert', 'preset_update') THEN
    RAISE EXCEPTION 'save_agent: 허용되지 않는 kind %', p_kind;
  END IF;

  SELECT * INTO cur FROM agents WHERE id = p_agent_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- 함께 고칠 때 덮어쓰기 막기
  IF p_base_version IS DISTINCT FROM cur.version THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'conflict', 'current_version', cur.version);
  END IF;

  before_snap := agent_snapshot(cur);

  IF p_patch ? 'template_ids' THEN
    UPDATE agent_templates SET retired_at = now()
     WHERE agent_id = p_agent_id AND retired_at IS NULL
       AND id::text NOT IN (SELECT jsonb_array_elements_text(p_patch -> 'template_ids'));
    UPDATE agent_templates SET retired_at = NULL
     WHERE agent_id = p_agent_id AND retired_at IS NOT NULL
       AND id::text IN (SELECT jsonb_array_elements_text(p_patch -> 'template_ids'));
    SELECT count(*) INTO active_count
      FROM agent_templates WHERE agent_id = p_agent_id AND retired_at IS NULL;
    IF active_count > 10 THEN
      RAISE EXCEPTION '양식은 비서당 10개까지입니다.' USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE agents SET
    name            = CASE WHEN p_patch ? 'name'          THEN p_patch ->> 'name'          ELSE name END,
    description     = CASE WHEN p_patch ? 'description'   THEN p_patch ->> 'description'   ELSE description END,
    icon            = CASE WHEN p_patch ? 'icon'          THEN p_patch ->> 'icon'          ELSE icon END,
    color           = CASE WHEN p_patch ? 'color'         THEN p_patch ->> 'color'         ELSE color END,
    category        = CASE WHEN p_patch ? 'category'      THEN p_patch ->> 'category'      ELSE category END,
    usage_guide     = CASE WHEN p_patch ? 'usage_guide'   THEN p_patch ->> 'usage_guide'   ELSE usage_guide END,
    system_prompt   = CASE WHEN p_patch ? 'system_prompt' THEN p_patch ->> 'system_prompt' ELSE system_prompt END,
    model_id        = CASE WHEN p_patch ? 'model_id'      THEN p_patch ->> 'model_id'      ELSE model_id END,
    starter_prompts = CASE
                        WHEN NOT (p_patch ? 'starter_prompts') THEN starter_prompts
                        WHEN jsonb_typeof(p_patch -> 'starter_prompts') = 'array'
                          THEN ARRAY(SELECT jsonb_array_elements_text(p_patch -> 'starter_prompts'))
                        ELSE NULL
                      END,
    capabilities    = CASE
                        WHEN NOT (p_patch ? 'capabilities') THEN capabilities
                        WHEN jsonb_typeof(p_patch -> 'capabilities') = 'object' THEN p_patch -> 'capabilities'
                        ELSE '{}'::jsonb
                      END,
    version         = cur.version + 1,
    -- 기본 비서 갱신(p_actor NULL)은 '사람이 고친 비서' 표시를 남기지 않는다
    updated_by      = COALESCE(p_actor, updated_by),
    updated_at      = now()
  WHERE id = p_agent_id
  RETURNING * INTO saved;

  after_snap := agent_snapshot(saved);

  INSERT INTO agent_history (agent_id, kind, version, snapshot, changed_by, detail)
  VALUES (
    p_agent_id, p_kind, saved.version, after_snap, p_actor,
    COALESCE(p_detail, '{}'::jsonb) || jsonb_build_object('fields', COALESCE(
      (SELECT jsonb_agg(n.key ORDER BY n.key)
         FROM jsonb_each(after_snap) AS n(key, value)
        WHERE n.value IS DISTINCT FROM before_snap -> n.key),
      '[]'::jsonb)));

  RETURN jsonb_build_object('ok', true, 'version', saved.version);
END $$;


-- ── 12. 단계 변경 ─────────────────────────────────────────────
-- 판 번호는 올리지 않는다(사본 칸이 아님). 단계와 기록은 함께 남긴다.
CREATE OR REPLACE FUNCTION change_agent_tier(
  p_agent_id      uuid,
  p_tier          text,
  p_actor         uuid,
  p_department_id uuid,
  p_visibility    text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  cur agents%ROWTYPE;
BEGIN
  IF p_tier NOT IN ('department', 'official') THEN
    RAISE EXCEPTION 'change_agent_tier: 올릴 수 없는 단계 %', p_tier;
  END IF;
  -- NULL을 그대로 쓰면 공개 범위가 빈 비서가 되어 visibilityFilter에 걸리지 않는다
  IF p_visibility IS NULL OR p_visibility NOT IN ('organization', 'department') THEN
    RAISE EXCEPTION 'change_agent_tier: 허용되지 않는 공개 범위 %', p_visibility;
  END IF;

  SELECT * INTO cur FROM agents WHERE id = p_agent_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  UPDATE agents SET
    tier             = p_tier,
    owner_id         = NULL,
    department_id    = COALESCE(p_department_id, department_id),
    visibility       = p_visibility,
    approval_status  = CASE WHEN p_tier = 'official' THEN 'approved' ELSE approval_status END,
    approval_version = CASE WHEN p_tier = 'official' THEN NULL ELSE approval_version END,
    updated_by       = p_actor,
    updated_at       = now()
  WHERE id = p_agent_id;

  INSERT INTO agent_history (agent_id, kind, changed_by, detail)
  VALUES (p_agent_id, 'tier', p_actor,
          jsonb_build_object('from', cur.tier, 'to', p_tier, 'visibility', p_visibility));

  RETURN jsonb_build_object('ok', true);
END $$;


-- ── 13. 능력 하나 켜기 (문서 업로드가 doc_search를 켤 때) ──────
-- 지금은 문서만 올리면 바로 검색된다. 같은 동작을 지키되 판에도 남긴다.
CREATE OR REPLACE FUNCTION enable_agent_capability(
  p_agent_id   uuid,
  p_capability text,
  p_actor      uuid
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  cur agents%ROWTYPE;
BEGIN
  SELECT * INTO cur FROM agents WHERE id = p_agent_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR cur.capabilities ? p_capability THEN
    RETURN;
  END IF;
  -- 사람이 고친 것이 아니다. p_actor를 넘기면 save_agent가 updated_by를 바꿔
  -- 기본 비서 갱신(--update)이 이 비서를 '관리자가 고친 것'으로 보고 건너뛴다.
  -- 누가 문서를 올려 켜졌는지는 detail에 남긴다.
  PERFORM save_agent(
    p_agent_id, cur.version,
    jsonb_build_object('capabilities', cur.capabilities || jsonb_build_object(p_capability, '{}'::jsonb)),
    NULL, 'settings',
    jsonb_build_object('reason', 'auto_enable', 'capability', p_capability, 'actor', p_actor));
END $$;


-- ── 확인 ─────────────────────────────────────────────────────
-- 이름정리: 3절에서 ' (N)'을 붙인 나만의 비서 수(단계와 무관하게 모든 줄에 같은 값).
-- 0이 아니면 _0026_personal_renamed에 old_name → new_name이 있다(이 트랜잭션 안에서만).
SELECT tier AS 단계, count(*) AS 비서수,
       count(*) FILTER (WHERE capabilities ? 'doc_search')  AS 문서찾기,
       count(*) FILTER (WHERE capabilities ? 'public_data') AS 공공데이터,
       (SELECT count(*) FROM _0026_personal_renamed)         AS 이름정리
  FROM agents GROUP BY tier ORDER BY tier;
