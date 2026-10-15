-- =============================================================
-- 0029_generated_files.sql
-- 비서가 만든 파일 (S2-a)
--
-- 설계: docs/superpowers/specs/2026-10-15-s2-document-fill-design.md 5절
--
-- 배포 순서: 이 파일 → S2-a 코드. 코드가 이 표에 쓴다.
-- 파일 바이트는 저장소(documents 버킷 generated/…)에 있고 여기는 기록이다.
-- 대화를 지우면 행이 함께 지워진다. 저장소 파일은 대화 삭제 라우트가 먼저 지운다.
-- =============================================================

CREATE TABLE IF NOT EXISTS generated_files (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department_id   uuid NOT NULL REFERENCES departments(id),
  organization_id uuid REFERENCES organizations(id),
  agent_id        uuid REFERENCES agents(id) ON DELETE SET NULL,
  template_ref    text NOT NULL,
  template_name   text NOT NULL,
  file_name       text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 120),
  mime_type       text NOT NULL,
  size_bytes      integer NOT NULL CHECK (size_bytes >= 0),
  storage_path    text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_generated_files_conversation ON generated_files(conversation_id);
CREATE INDEX IF NOT EXISTS idx_generated_files_user ON generated_files(user_id, created_at DESC);

COMMENT ON TABLE generated_files IS
  '비서가 만든 파일(양식 채우기·표준 서식). 주인(user_id)만 내려받는다. 대화와 수명을 같이 한다.';

-- 기관은 부서에서 채운다 (0016과 같은 함수)
DROP TRIGGER IF EXISTS trg_generated_files_fill_org ON generated_files;
CREATE TRIGGER trg_generated_files_fill_org
  BEFORE INSERT OR UPDATE OF department_id ON generated_files
  FOR EACH ROW EXECUTE FUNCTION fill_organization_id_from_department();

-- ── 확인 ─────────────────────────────────────────────────────
SELECT tgname FROM pg_trigger WHERE tgrelid = 'generated_files'::regclass AND NOT tgisinternal;
-- trg_generated_files_fill_org 1행이어야 한다
