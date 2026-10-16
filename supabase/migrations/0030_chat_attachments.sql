-- =============================================================
-- 0030_chat_attachments.sql
-- 채팅 첨부 파일 기록 (S3-a)
--
-- 설계: docs/superpowers/specs/2026-10-17-s3-file-read-table-merge-design.md 4.2절
--
-- 배포 순서: 이 파일 → S3-a 코드. **코드 배포 전에 적용**한다 — 코드가 이 표에 쓴다.
-- 파일 바이트는 저장소(documents 버킷 chat-uploads/…)에 있고 여기는 기록이다.
-- 원본과 읽은 내용(JSON)의 경로를 둘 다 적는다. 경로에는 파일 이름을 넣지 않는다.
-- 처음엔 대화에 묶이지 않는다(conversation_id NULL). 첫 턴에서 그 대화로 묶는다.
-- 대화를 지우면 행이 함께 지워진다. 저장소 객체는 대화 삭제 라우트가 먼저 지운다.
-- 확인 거부(시간·크기)·보내기 전 삭제는 행을 지우지 않고 failed로 남긴다 — 서명 업로드 주소가
-- 2시간 살아 있어, 행을 지우면 그 사이 다시 올린 객체가 기록 없이 남는다.
-- 묶이지 않은 채 24시간 지난 행은 그 사용자가 다음에 올릴 때 코드가 객체와 함께 지운다.
-- 주인(user_id)만 쓴다 — 관리자도 남의 첨부를 보지 못한다. RLS가 없으므로 격리는 코드 조건에 달렸다.
-- =============================================================

CREATE TABLE IF NOT EXISTS chat_attachments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department_id   uuid NOT NULL REFERENCES departments(id),
  organization_id uuid REFERENCES organizations(id),
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  file_name       text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  mime_type       text NOT NULL,
  size_bytes      integer NOT NULL CHECK (size_bytes >= 0),
  storage_path    text NOT NULL UNIQUE,
  extract_path    text UNIQUE,
  status          text NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  summary         jsonb,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- 읽힌 첨부만 읽은 내용 경로가 있다. 코드가 두 칸을 한 변경에서 맞추는지 DB가 다시 본다
  CONSTRAINT chat_attachments_ready_has_extract CHECK ((status = 'ready') = (extract_path IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_chat_attachments_conversation ON chat_attachments(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_attachments_user ON chat_attachments(user_id, created_at DESC);

COMMENT ON TABLE chat_attachments IS
  '채팅 첨부 파일(원본·읽은 내용 경로와 요약). 주인(user_id)만 쓴다. 대화에 묶이면 대화와 수명을 같이 한다.';
COMMENT ON COLUMN chat_attachments.extract_path IS
  '읽은 내용 JSON 경로. pending·failed면 NULL';
COMMENT ON COLUMN chat_attachments.size_bytes IS
  '발급 때는 신고한 크기, 확인 뒤에는 실제로 올라간 크기';

-- 기관은 부서에서 채운다 (0016·0029와 같은 함수)
DROP TRIGGER IF EXISTS trg_chat_attachments_fill_org ON chat_attachments;
CREATE TRIGGER trg_chat_attachments_fill_org
  BEFORE INSERT OR UPDATE OF department_id ON chat_attachments
  FOR EACH ROW EXECUTE FUNCTION fill_organization_id_from_department();

-- ── 확인 ─────────────────────────────────────────────────────
SELECT tgname FROM pg_trigger WHERE tgrelid = 'chat_attachments'::regclass AND NOT tgisinternal;
-- trg_chat_attachments_fill_org 1행이어야 한다
