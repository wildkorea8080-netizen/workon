-- =============================================================
-- 0033_common_documents.sql
-- 공통 자료실 — 기관 유형 단위 참고 문서 표 (S5)
--
-- 설계: docs/superpowers/specs/2026-10-25-s5-common-library-design.md 4절
--
-- 배포 순서: 이 파일 → S5 코드 푸시(배포 확인). **코드 배포 전에 적용**한다 — 코드가 이 표를 읽고 쓴다.
-- 이 파일은 사용자가 직접 적용한다.
--
-- 기관·부서 칸이 없다 — 유형(org_type) 단위 자료다. 그래서 visibilityFilter·기관 채움 트리거의 대상이 아니다.
-- 올리는 사람은 슈퍼관리자뿐이고(uploaded_by = users.id), 읽는 쪽은 기관 유형이 같은 직원의 대화다.
-- RLS는 켜지 않는다(이 프로젝트는 service role로만 접근한다 — CLAUDE.md '구조적 위험').
--
-- noda_status (documents와 같은 뜻 + retired)
--   reading     NODA가 읽는 중(또는 아직 보내지 못함)
--   ready       읽기 끝 — 대화에서 근거로 쓴다
--   failed      읽기 실패 — 다시 시도할 수 있다(원본은 저장소에 남아 있다)
--   unreadable  NODA가 읽을 수 없다고 답함 — 다시 해도 같다
--   deleting    NODA 삭제 실패 — 행을 남기고 다시 지우기를 기다린다
--   retired     지난 판 — 새 판이 ready가 되어 NODA 사본을 지웠다(행·원본은 감사용으로 남는다)
--
-- noda_filename = '{common_document_id}__{이름}({기준 연도}){원래 확장자}'. 유일하다.
-- 같은 유형·같은 이름의 현재 판(retired_at IS NULL)은 하나라는 규칙은 DB 인덱스가 아니라 확인 라우트가 막는다
-- (새 판이 읽히는 동안 옛 판도 현재 판으로 남아야 하기 때문).
-- updated_at은 이 표만을 위한 트리거를 두지 않는다 — 다른 표들도 트리거 없이 코드가 갱신 때 직접 쓴다.
-- =============================================================

CREATE TABLE IF NOT EXISTS common_documents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_type              text NOT NULL
                          CHECK (org_type IN ('중앙행정기관','지방자치단체','공공기관','교육기관','협회단체','일반기업')),
  title                 text NOT NULL CHECK (length(trim(title)) > 0),
  edition_year          integer NOT NULL CHECK (edition_year BETWEEN 2000 AND 2100),
  usage_terms           text NOT NULL CHECK (length(trim(usage_terms)) > 0),
  file_name             text NOT NULL,
  file_type             text,
  size_bytes            bigint,
  storage_path          text NOT NULL,
  noda_status           text NOT NULL DEFAULT 'reading'
                          CHECK (noda_status IN ('reading','ready','failed','unreadable','deleting','retired')),
  noda_reason           text,
  noda_filename         text UNIQUE,
  noda_doc_id           text,
  noda_read_started_at  timestamptz,
  noda_last_attempt_at  timestamptz,
  noda_read_at          timestamptz,
  replaces_id           uuid REFERENCES common_documents(id) ON DELETE SET NULL,
  retired_at            timestamptz,
  uploaded_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS common_documents_type_status_idx ON common_documents(org_type, noda_status);

COMMENT ON TABLE common_documents IS
  '공통 자료실(S5) — 기관 유형 단위 참고 문서. 기관·부서 칸 없음';
COMMENT ON COLUMN common_documents.usage_terms IS
  '이용 조건 확인 기록(예: 공공누리 1유형 · 2026-10-25 확인). 비우면 올리지 못한다';
COMMENT ON COLUMN common_documents.replaces_id IS
  '이 문서가 대신하는 옛 판';

-- ── 확인 ─────────────────────────────────────────────────────
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'common_documents'
 ORDER BY ordinal_position;
-- 21행이어야 한다 (id … updated_at)
