-- 0034 업무 작업 도메인 (WORKON 개편 P1 — docs/workon-rebuild/05_DATA_API_AND_JOBS.md)
--
-- 추가만 한다. 기존 표(agents·documents·conversations·generated_files·usage_logs…)는 건드리지 않는다.
-- 코드 배포 전에 적용한다(새 코드가 이 표를 읽고 쓴다). 옛 코드는 이 표를 모르므로 먼저 적용해도 안전하다.
--
-- 원칙
--  - 작업·버전·파일·실행은 **대화와 수명이 따로**다. conversations를 참조하지 않는다 — 대화를 지워도 남는다
--  - 기관이 다른 행끼리 묶이지 않게 자식 표는 (task_id, organization_id) 복합 FK로 작업을 가리킨다
--  - organization_id는 서버가 요청자 소속에서 정해 넣고, 트리거가 부서·사용자의 기관과 맞는지 다시 본다
--  - 사람(owner·actor) 칸은 users를 FK로 묶지 않는다 — 사용자를 지워도 업무 기록은 남아야 하고,
--    FK가 있으면 기존 사용자 삭제(슈퍼관리자 화면)가 막힌다
--  - RLS를 켜고 정책을 두지 않는다 — anon·authenticated 토큰으로는 아무것도 못 읽는다.
--    앱은 service role(RLS 우회)로 접근하므로 **격리는 서버 코드(src/lib/work/access.ts)가 한다**. RLS는 추가 방어일 뿐이다
--  - 작업 삭제는 이 도메인 안에서만 연쇄된다(work_tasks → 자식). 다른 도메인의 CASCADE를 넓히지 않는다

-- ── 기관별 전환 스위치 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS work_org_settings (
  organization_id   uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  home_enabled      boolean NOT NULL DEFAULT false,   -- 직원 홈을 업무 홈으로
  new_tasks_enabled boolean NOT NULL DEFAULT false,   -- 새 작업 시작·실행 허용(끄면 기존 작업은 읽기·내려받기만)
  updated_by        uuid,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ── 업무 비서 설치 ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow_installations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_key        text NOT NULL CHECK (workflow_key IN ('intake','official-letter','report','collection','settlement',
                                                            'regulations','meeting','reply','audit-response','handover')),
  workflow_version    text NOT NULL,
  agent_id            uuid REFERENCES agents(id) ON DELETE SET NULL,
  status              text NOT NULL DEFAULT 'preparing' CHECK (status IN ('preparing','available','disabled')),
  installed_by        uuid,
  installed_at        timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, workflow_key)
);

-- ── 양식 판 ───────────────────────────────────────────────────
-- organization_id NULL = WORKON 표준 양식(저장소 assets/templates). 그 밖에는 기관 양식.
CREATE TABLE IF NOT EXISTS work_template_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid REFERENCES organizations(id) ON DELETE CASCADE,
  source             text NOT NULL CHECK (source IN ('builtin','agent_template','upload')),
  builtin_ref        text,
  agent_template_id  uuid REFERENCES agent_templates(id) ON DELETE SET NULL,
  storage_path       text,
  name               text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  file_name          text NOT NULL,
  format             text NOT NULL CHECK (format IN ('hwpx','docx','xlsx')),
  sha256             text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  version            integer NOT NULL DEFAULT 1 CHECK (version > 0),
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','mapped','verified','retired')),
  manifest           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- 채울 자리(필드) 목록 — 이 파일(sha256) 안에서만 유효
  supported          jsonb NOT NULL DEFAULT '{}'::jsonb,   -- text·paragraphs·existingCells·repeatRows·imageInsert·exactPreview
  verification       jsonb,                                -- 실제 한글 검증 기록(없으면 NULL)
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((source = 'builtin') = (builtin_ref IS NOT NULL)),
  CHECK ((source = 'builtin') = (organization_id IS NULL)),
  CHECK (source = 'builtin' OR storage_path IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS work_template_versions_builtin_uq ON work_template_versions (builtin_ref, sha256) WHERE source = 'builtin';
CREATE UNIQUE INDEX IF NOT EXISTS work_template_versions_org_uq ON work_template_versions (organization_id, sha256) WHERE organization_id IS NOT NULL;

-- ── 작업 ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS work_tasks (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             uuid NOT NULL REFERENCES organizations(id),
  department_id               uuid NOT NULL REFERENCES departments(id),
  owner_id                    uuid NOT NULL,
  workflow_key                text NOT NULL CHECK (workflow_key IN ('intake','official-letter','report','collection','settlement',
                                                                    'regulations','meeting','reply','audit-response','handover')),
  workflow_version            text NOT NULL,
  agent_id                    uuid REFERENCES agents(id) ON DELETE SET NULL,
  agent_version               integer,
  title                       text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  status                      text NOT NULL DEFAULT 'draft'
                                CHECK (status IN ('draft','ready','processing','needs_review','approved','completed','archived')),
  revision                    integer NOT NULL DEFAULT 0,
  form                        jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(form) = 'object' AND pg_column_size(form) <= 262144),
  template_version_id         uuid REFERENCES work_template_versions(id),
  current_document_version_id uuid,
  current_run_id              uuid,
  due_date                    date,
  visibility                  text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','explicit_members')),
  approved_version_id         uuid,
  approved_by                 uuid,
  approved_at                 timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  archived_at                 timestamptz,
  UNIQUE (id, organization_id)
);
CREATE INDEX IF NOT EXISTS work_tasks_owner_idx ON work_tasks (organization_id, owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS work_task_members (
  task_id          uuid NOT NULL,
  organization_id  uuid NOT NULL,
  user_id          uuid NOT NULL,
  role             text NOT NULL CHECK (role IN ('viewer','editor','reviewer')),
  granted_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, user_id),
  FOREIGN KEY (task_id, organization_id) REFERENCES work_tasks (id, organization_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS work_task_members_user_idx ON work_task_members (organization_id, user_id);

-- ── 원자료 ────────────────────────────────────────────────────
-- 대화 첨부(chat_attachments)와 수명이 따로다 — 24시간 정리·대화 삭제가 이 표를 건드리지 않는다
CREATE TABLE IF NOT EXISTS work_sources (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id          uuid NOT NULL,
  organization_id  uuid NOT NULL,
  uploaded_by      uuid NOT NULL,
  purpose          text NOT NULL DEFAULT 'reference' CHECK (purpose IN ('reference','data','request','template','evidence')),
  file_name        text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  file_ext         text NOT NULL CHECK (file_ext ~ '^[a-z0-9]{1,8}$'),
  size_bytes       bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  sha256           text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  storage_path     text NOT NULL UNIQUE,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','failed')),
  extract_path     text,
  summary          jsonb,
  failure_reason   text,
  origin           jsonb,      -- 가져온 곳(대화 첨부·다른 작업의 파일) — 참조만, 원본을 옮기지 않는다
  created_at       timestamptz NOT NULL DEFAULT now(),
  confirmed_at     timestamptz,
  UNIQUE (id, task_id),
  FOREIGN KEY (task_id, organization_id) REFERENCES work_tasks (id, organization_id) ON DELETE CASCADE,
  CHECK ((status = 'ready') = (sha256 IS NOT NULL AND confirmed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS work_sources_task_idx ON work_sources (task_id, created_at);

-- ── 문서 판 ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS work_document_versions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id              uuid NOT NULL,
  organization_id      uuid NOT NULL,
  version              integer NOT NULL CHECK (version > 0),
  parent_version_id    uuid,
  template_version_id  uuid REFERENCES work_template_versions(id),
  source_ids           uuid[] NOT NULL DEFAULT '{}',
  fields               jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'array' AND pg_column_size(fields) <= 1048576),
  -- 문서 칸이 아닌 업무 결과(취합 결과·직원 결정 등). 업무마다 꼴이 다르고 서버가 런타임 스키마로 검사한다
  content              jsonb CHECK (content IS NULL OR (jsonb_typeof(content) = 'object' AND pg_column_size(content) <= 2097152)),
  origin               text NOT NULL CHECK (origin IN ('generate','edit','revise','restore','import')),
  change_reason        text NOT NULL DEFAULT '' CHECK (char_length(change_reason) <= 500),
  run_id               uuid,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, version),
  UNIQUE (id, task_id),
  FOREIGN KEY (task_id, organization_id) REFERENCES work_tasks (id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (parent_version_id, task_id) REFERENCES work_document_versions (id, task_id)
);

ALTER TABLE work_tasks
  ADD CONSTRAINT work_tasks_current_version_fk
  FOREIGN KEY (current_document_version_id, id) REFERENCES work_document_versions (id, task_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE work_tasks
  ADD CONSTRAINT work_tasks_approved_version_fk
  FOREIGN KEY (approved_version_id, id) REFERENCES work_document_versions (id, task_id) DEFERRABLE INITIALLY DEFERRED;

-- ── 실행 ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS work_runs (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id                    uuid NOT NULL,
  organization_id            uuid NOT NULL,
  operation                  text NOT NULL CHECK (operation IN ('generate','revise','validate','render','package')),
  idempotency_key            text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  payload                    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(payload) <= 65536),
  payload_hash               text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  base_version               integer NOT NULL DEFAULT 0 CHECK (base_version >= 0),
  input_document_version_id  uuid,
  status                     text NOT NULL DEFAULT 'queued'
                               CHECK (status IN ('queued','running','succeeded','failed','canceled','superseded')),
  attempt                    integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts               integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  lease_owner                text,
  lease_until                timestamptz,
  heartbeat_at               timestamptz,
  available_at               timestamptz NOT NULL DEFAULT now(),
  cancel_requested_at        timestamptz,
  error                      jsonb,      -- { code, safeMessage, retryable } — 원문·키·서명 주소를 싣지 않는다
  result                     jsonb,
  requested_by               uuid NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  started_at                 timestamptz,
  finished_at                timestamptz,
  UNIQUE (organization_id, task_id, operation, idempotency_key),
  UNIQUE (id, organization_id),
  UNIQUE (id, task_id),
  FOREIGN KEY (task_id, organization_id) REFERENCES work_tasks (id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (input_document_version_id, task_id) REFERENCES work_document_versions (id, task_id),
  CHECK (status <> 'running' OR (lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS work_runs_claim_idx ON work_runs (available_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS work_runs_lease_idx ON work_runs (lease_until) WHERE status = 'running';

ALTER TABLE work_tasks
  ADD CONSTRAINT work_tasks_current_run_fk
  FOREIGN KEY (current_run_id, id) REFERENCES work_runs (id, task_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE work_document_versions
  ADD CONSTRAINT work_document_versions_run_fk
  FOREIGN KEY (run_id, task_id) REFERENCES work_runs (id, task_id) DEFERRABLE INITIALLY DEFERRED;

-- 단계 체크포인트 — 다시 시도할 때 끝난 단계(모델 호출 포함)를 다시 하지 않는다
CREATE TABLE IF NOT EXISTS work_run_steps (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL,
  organization_id  uuid NOT NULL,
  step             text NOT NULL CHECK (step ~ '^[a-z_]{1,40}$'),
  attempt          integer NOT NULL,
  status           text NOT NULL CHECK (status IN ('running','succeeded','failed')),
  input_hash       text,
  output           jsonb CHECK (output IS NULL OR pg_column_size(output) <= 1048576),
  error            jsonb,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  UNIQUE (run_id, step),
  FOREIGN KEY (run_id, organization_id) REFERENCES work_runs (id, organization_id) ON DELETE CASCADE
);

-- ── 결과 파일 ─────────────────────────────────────────────────
-- 파일 내용은 불변이다. 같은 판·같은 산출물 키의 파일은 하나 — 다시 시도해도 두 벌이 생기지 않는다
CREATE TABLE IF NOT EXISTS work_artifacts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  task_id              uuid NOT NULL,
  document_version_id  uuid NOT NULL,
  run_id               uuid,
  output_key           text NOT NULL CHECK (output_key ~ '^[A-Za-z0-9_-]{1,40}$'),
  format               text NOT NULL CHECK (format IN ('hwpx','xlsx','pdf','zip','docx')),
  file_name            text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  mime_type            text NOT NULL,
  size_bytes           bigint NOT NULL CHECK (size_bytes > 0),
  sha256               text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_path         text NOT NULL UNIQUE,
  validation_status    text NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('pending','valid','invalid')),
  validation           jsonb,
  preview_status       text NOT NULL DEFAULT 'pending' CHECK (preview_status IN ('pending','ready','failed','unsupported')),
  preview              jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_version_id, output_key),
  FOREIGN KEY (task_id, organization_id) REFERENCES work_tasks (id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (document_version_id, task_id) REFERENCES work_document_versions (id, task_id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, task_id) REFERENCES work_runs (id, task_id)
);
CREATE INDEX IF NOT EXISTS work_artifacts_task_idx ON work_artifacts (task_id, created_at DESC);

-- ── 확인할 사항·근거 ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS work_review_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  task_id              uuid NOT NULL,
  document_version_id  uuid NOT NULL,
  severity             text NOT NULL CHECK (severity IN ('blocking','warning','info')),
  code                 text NOT NULL CHECK (code ~ '^[A-Z0-9_]{1,60}$'),
  message              text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 1000),
  field_ids            text[] NOT NULL DEFAULT '{}',
  evidence_ids         uuid[] NOT NULL DEFAULT '{}',
  state                text NOT NULL DEFAULT 'open' CHECK (state IN ('open','resolved','acknowledged')),
  resolved_by          uuid,
  resolution_note      text CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 500),
  resolved_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (task_id, organization_id) REFERENCES work_tasks (id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (document_version_id, task_id) REFERENCES work_document_versions (id, task_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS work_review_items_version_idx ON work_review_items (document_version_id);

CREATE TABLE IF NOT EXISTS work_evidence (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  task_id          uuid NOT NULL,
  source_id        uuid NOT NULL,
  locator          jsonb NOT NULL DEFAULT '{}'::jsonb,   -- 실제로 아는 위치만(쪽·시트·칸·표·추출 행) — 추정 주소를 만들지 않는다
  field_ids        text[] NOT NULL DEFAULT '{}',
  quote            text CHECK (quote IS NULL OR char_length(quote) <= 2000),
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (task_id, organization_id) REFERENCES work_tasks (id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (source_id, task_id) REFERENCES work_sources (id, task_id) ON DELETE CASCADE
);

-- ── AI 수정 후보 ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS work_revision_proposals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  task_id             uuid NOT NULL,
  base_version        integer NOT NULL CHECK (base_version > 0),
  field_ids           text[] NOT NULL CHECK (cardinality(field_ids) BETWEEN 1 AND 20),
  instruction         text NOT NULL CHECK (char_length(btrim(instruction)) BETWEEN 1 AND 1000),
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','applied','rejected','failed','stale')),
  proposal            jsonb,      -- [{ fieldId, before, after }]
  run_id              uuid,
  applied_version_id  uuid,
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (task_id, organization_id) REFERENCES work_tasks (id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, task_id) REFERENCES work_runs (id, task_id)
);

-- ── 감사 이벤트 ────────────────────────────────────────────────
-- 본문·파일 이름 원문·비밀값·서명 주소는 싣지 않는다
CREATE TABLE IF NOT EXISTS work_events (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id          uuid,   -- NULL = 작업 없는 기관 단위 사건(기관 양식 등록·업무 켜고 끄기 — 관리자)
  actor_id         uuid,
  type             text NOT NULL CHECK (type ~ '^[a-z_.]{1,60}$'),
  details          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(details) <= 8192),
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (task_id, organization_id) REFERENCES work_tasks (id, organization_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS work_events_task_idx ON work_events (task_id, id);
CREATE INDEX IF NOT EXISTS work_events_org_idx ON work_events (organization_id, id) WHERE task_id IS NULL;

-- ── 기관 일치 트리거 ───────────────────────────────────────────
-- 서버가 넣은 organization_id가 부서의 기관과 같아야 한다(작업)
CREATE OR REPLACE FUNCTION work_tasks_check_org() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM departments d WHERE d.id = NEW.department_id AND d.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'work_tasks: department % is not in organization %', NEW.department_id, NEW.organization_id
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.organization_id <> OLD.organization_id) THEN
    RAISE EXCEPTION 'work_tasks: organization_id is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_work_tasks_check_org ON work_tasks;
CREATE TRIGGER trg_work_tasks_check_org BEFORE INSERT OR UPDATE OF organization_id, department_id ON work_tasks
  FOR EACH ROW EXECUTE FUNCTION work_tasks_check_org();

-- 구성원은 같은 기관 사용자만
CREATE OR REPLACE FUNCTION work_task_members_check_org() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM users u JOIN departments d ON d.id = u.department_id
     WHERE u.id = NEW.user_id AND d.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'work_task_members: user % is not in organization %', NEW.user_id, NEW.organization_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_work_task_members_check_org ON work_task_members;
CREATE TRIGGER trg_work_task_members_check_org BEFORE INSERT OR UPDATE ON work_task_members
  FOR EACH ROW EXECUTE FUNCTION work_task_members_check_org();

-- 양식 판은 그 작업의 기관 양식이거나 표준 양식이어야 한다
CREATE OR REPLACE FUNCTION work_template_org_ok(p_template uuid, p_org uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT p_template IS NULL OR EXISTS (
    SELECT 1 FROM work_template_versions t WHERE t.id = p_template AND (t.organization_id IS NULL OR t.organization_id = p_org))
$$;
ALTER TABLE work_tasks ADD CONSTRAINT work_tasks_template_org_ck CHECK (work_template_org_ok(template_version_id, organization_id)) NOT VALID;
ALTER TABLE work_document_versions ADD CONSTRAINT work_document_versions_template_org_ck
  CHECK (work_template_org_ok(template_version_id, organization_id)) NOT VALID;

-- ── 문서 판 저장 (원자적, 기준 판 확인) ─────────────────────────
-- 기준 판이 지금 판과 다르면 WK409(VERSION_CONFLICT). p_run_id가 있으면 그 실행이 작업의 현재 실행일 때만 저장한다
-- (늦게 끝난 옛 실행이 새 판을 덮지 않게 — WK410 SUPERSEDED).
CREATE OR REPLACE FUNCTION work_save_document_version(
  p_task_id uuid, p_org uuid, p_base_version integer, p_fields jsonb, p_template_version_id uuid,
  p_origin text, p_reason text, p_actor uuid, p_run_id uuid, p_source_ids uuid[], p_content jsonb DEFAULT NULL
) RETURNS work_document_versions LANGUAGE plpgsql AS $$
DECLARE
  t work_tasks;
  cur integer;
  cur_id uuid;
  v work_document_versions;
BEGIN
  SELECT * INTO t FROM work_tasks WHERE id = p_task_id AND organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TASK_NOT_FOUND' USING ERRCODE = 'WK404'; END IF;
  IF t.status = 'archived' THEN RAISE EXCEPTION 'TASK_ARCHIVED' USING ERRCODE = 'WK423'; END IF;
  IF p_run_id IS NOT NULL AND t.current_run_id IS DISTINCT FROM p_run_id THEN
    RAISE EXCEPTION 'SUPERSEDED' USING ERRCODE = 'WK410';
  END IF;
  SELECT version, id INTO cur, cur_id FROM work_document_versions WHERE id = t.current_document_version_id;
  cur := COALESCE(cur, 0);
  IF p_base_version <> cur THEN
    RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE = 'WK409', DETAIL = cur::text;
  END IF;
  INSERT INTO work_document_versions (task_id, organization_id, version, parent_version_id, template_version_id,
                                      source_ids, fields, content, origin, change_reason, run_id, created_by)
  VALUES (p_task_id, p_org, cur + 1, cur_id, COALESCE(p_template_version_id, t.template_version_id),
          COALESCE(p_source_ids, '{}'), p_fields, p_content, p_origin, COALESCE(p_reason, ''), p_run_id, p_actor)
  RETURNING * INTO v;
  UPDATE work_tasks
     SET current_document_version_id = v.id, revision = revision + 1, updated_at = now(),
         -- 판이 바뀌면 이전 승인은 효력을 잃는다
         approved_version_id = NULL, approved_by = NULL, approved_at = NULL,
         status = CASE WHEN status IN ('approved','completed') THEN 'needs_review' ELSE status END
   WHERE id = p_task_id;
  RETURN v;
END $$;

-- ── 실행 넣기 (멱등) ───────────────────────────────────────────
-- 같은 키·같은 내용이면 그 실행을 돌려준다. 같은 키에 다른 내용이면 WK409(IDEMPOTENCY_CONFLICT).
-- 같은 작업·같은 종류의 대기 중인 옛 실행은 superseded가 된다(실행 중인 것은 끝날 때 알아챈다).
-- **문서 판을 만드는 실행(generate)만** 작업의 현재 실행이 되고 작업을 처리 중으로 바꾼다 —
-- 파일 만들기(package)·수정 후보(revise)는 판을 만들지 않으므로 생성 실행을 밀어내지 않는다.
CREATE OR REPLACE FUNCTION work_enqueue_run(
  p_task_id uuid, p_org uuid, p_operation text, p_key text, p_payload jsonb, p_payload_hash text,
  p_base_version integer, p_input_version uuid, p_requested_by uuid, p_max_attempts integer
) RETURNS TABLE (run work_runs, created boolean) LANGUAGE plpgsql AS $$
DECLARE
  r work_runs;
BEGIN
  PERFORM 1 FROM work_tasks WHERE id = p_task_id AND organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TASK_NOT_FOUND' USING ERRCODE = 'WK404'; END IF;
  SELECT * INTO r FROM work_runs
   WHERE organization_id = p_org AND task_id = p_task_id AND operation = p_operation AND idempotency_key = p_key;
  IF FOUND THEN
    IF r.payload_hash <> p_payload_hash THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = 'WK409';
    END IF;
    run := r; created := false; RETURN NEXT; RETURN;
  END IF;
  UPDATE work_runs SET status = 'superseded', finished_at = now()
   WHERE task_id = p_task_id AND operation = p_operation AND status = 'queued';
  INSERT INTO work_runs (task_id, organization_id, operation, idempotency_key, payload, payload_hash,
                         base_version, input_document_version_id, requested_by, max_attempts)
  VALUES (p_task_id, p_org, p_operation, p_key, p_payload, p_payload_hash,
          p_base_version, p_input_version, p_requested_by, COALESCE(p_max_attempts, 3))
  RETURNING * INTO r;
  IF p_operation = 'generate' THEN
    UPDATE work_tasks SET current_run_id = r.id, status = CASE WHEN status = 'archived' THEN status ELSE 'processing' END,
                          updated_at = now()
     WHERE id = p_task_id;
  END IF;
  run := r; created := true; RETURN NEXT;
END $$;

-- ── 실행 가져가기 (lease) ──────────────────────────────────────
-- 대기(available_at 지남) 또는 lease가 끝난 실행 중 하나를 잠그고 가져간다. 동시에 여러 작업자가 불러도 한 실행은 한 곳만.
-- 시도 횟수를 다 쓴 채 lease가 끝난 실행은 먼저 failed(LEASE_EXPIRED)로 닫는다.
CREATE OR REPLACE FUNCTION work_claim_runs(p_worker text, p_lease_seconds integer, p_limit integer, p_run_id uuid)
RETURNS SETOF work_runs LANGUAGE plpgsql AS $$
BEGIN
  UPDATE work_runs
     SET status = 'failed', finished_at = now(), lease_owner = NULL, lease_until = NULL,
         error = jsonb_build_object('code', 'LEASE_EXPIRED', 'safeMessage', '작업이 여러 번 중단되어 멈췄습니다. 다시 실행해 주세요.', 'retryable', true)
   WHERE status = 'running' AND lease_until < now() AND attempt >= max_attempts
     AND (p_run_id IS NULL OR id = p_run_id);
  UPDATE work_runs
     SET status = 'canceled', finished_at = now(), lease_owner = NULL, lease_until = NULL
   WHERE status = 'running' AND lease_until < now() AND cancel_requested_at IS NOT NULL
     AND (p_run_id IS NULL OR id = p_run_id);
  RETURN QUERY
  UPDATE work_runs w
     SET status = 'running', lease_owner = p_worker, lease_until = now() + make_interval(secs => p_lease_seconds),
         heartbeat_at = now(), attempt = w.attempt + 1, started_at = COALESCE(w.started_at, now())
   WHERE w.id IN (
     SELECT id FROM work_runs
      WHERE ((status = 'queued' AND available_at <= now()) OR (status = 'running' AND lease_until < now()))
        AND cancel_requested_at IS NULL
        AND (p_run_id IS NULL OR id = p_run_id)
      ORDER BY available_at, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT GREATEST(1, LEAST(p_limit, 20)))
  RETURNING w.*;
END $$;

CREATE OR REPLACE FUNCTION work_heartbeat_run(p_run_id uuid, p_worker text, p_lease_seconds integer)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  UPDATE work_runs SET heartbeat_at = now(), lease_until = now() + make_interval(secs => p_lease_seconds)
   WHERE id = p_run_id AND status = 'running' AND lease_owner = p_worker;
  RETURN FOUND;
END $$;

-- 끝내기. lease를 잃은 작업자의 결과는 받지 않는다('lost'). 실패가 다시 시도할 수 있고 횟수가 남았으면 대기로 되돌린다.
-- 성공이어도 그 사이 작업의 현재 실행이 바뀌었으면 superseded로 남긴다(결과는 기록으로만).
CREATE OR REPLACE FUNCTION work_finish_run(
  p_run_id uuid, p_worker text, p_status text, p_error jsonb, p_result jsonb, p_retry_delay_seconds integer
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  r work_runs;
  cur uuid;
BEGIN
  SELECT * INTO r FROM work_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'running' OR r.lease_owner IS DISTINCT FROM p_worker THEN RETURN 'lost'; END IF;
  IF p_status = 'failed' AND COALESCE((p_error ->> 'retryable')::boolean, false) AND r.attempt < r.max_attempts
     AND r.cancel_requested_at IS NULL THEN
    UPDATE work_runs SET status = 'queued', lease_owner = NULL, lease_until = NULL, error = p_error,
                         available_at = now() + make_interval(secs => GREATEST(0, p_retry_delay_seconds))
     WHERE id = p_run_id;
    RETURN 'requeued';
  END IF;
  SELECT current_run_id INTO cur FROM work_tasks WHERE id = r.task_id;
  UPDATE work_runs
     SET status = CASE WHEN p_status = 'succeeded' AND r.operation = 'generate' AND cur IS DISTINCT FROM r.id THEN 'superseded'
                       WHEN r.cancel_requested_at IS NOT NULL AND p_status <> 'succeeded' THEN 'canceled'
                       ELSE p_status END,
         lease_owner = NULL, lease_until = NULL, finished_at = now(), error = p_error, result = p_result
   WHERE id = p_run_id
   RETURNING status INTO r.status;
  RETURN r.status;
END $$;

-- ── RLS — 정책 없이 켠다(anon·authenticated 차단). service role은 우회한다 ──
ALTER TABLE work_org_settings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_installations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_template_versions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_tasks               ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_task_members        ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_sources             ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_document_versions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_runs                ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_run_steps           ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_artifacts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_review_items        ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_evidence            ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_revision_proposals  ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_events              ENABLE ROW LEVEL SECURITY;

-- 함수는 anon·authenticated가 PostgREST RPC로 부르지 못하게 한다(서버 service role만)
REVOKE EXECUTE ON FUNCTION work_save_document_version(uuid, uuid, integer, jsonb, uuid, text, text, uuid, uuid, uuid[], jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION work_enqueue_run(uuid, uuid, text, text, jsonb, text, integer, uuid, uuid, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION work_claim_runs(text, integer, integer, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION work_heartbeat_run(uuid, text, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION work_finish_run(uuid, text, text, jsonb, jsonb, integer) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION work_save_document_version(uuid, uuid, integer, jsonb, uuid, text, text, uuid, uuid, uuid[], jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION work_enqueue_run(uuid, uuid, text, text, jsonb, text, integer, uuid, uuid, integer) TO service_role;
    GRANT EXECUTE ON FUNCTION work_claim_runs(text, integer, integer, uuid) TO service_role;
    GRANT EXECUTE ON FUNCTION work_heartbeat_run(uuid, text, integer) TO service_role;
    GRANT EXECUTE ON FUNCTION work_finish_run(uuid, text, text, jsonb, jsonb, integer) TO service_role;
  END IF;
END $$;
