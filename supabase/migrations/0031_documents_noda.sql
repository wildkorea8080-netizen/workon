-- =============================================================
-- 0031_documents_noda.sql
-- 참고 문서를 NODA(문서 읽기 서비스)로 읽는다 — 문서 읽기 상태 칸 (S4-a)
--
-- 설계: docs/superpowers/specs/2026-10-21-s4-noda-document-layer-design.md 4·9절
--
-- 배포 순서: 이 파일 → `npm run noda:migrate`(기존 문서를 NODA로 옮김) → S4-a 코드.
-- **코드 배포 전에 적용**한다 — 코드가 이 칸들을 읽고 쓴다. 이 파일은 사용자가 직접 적용한다.
--
-- noda_status NULL = 옮기기 전 문서(옛 Voyage 임베딩으로 찾는다). 새 문서는 항상 값이 있다.
--   reading     NODA가 읽는 중(또는 아직 보내지 못함)
--   ready       읽기 끝 — 대화에서 근거로 쓴다
--   failed      읽기 실패 — 직원이 '다시 시도'할 수 있다(원본은 저장소에 남아 있다)
--   unreadable  NODA가 읽을 수 없다고 답함(readable:false, 암호 걸린 파일 등) — 다시 해도 같다
--   deleting    NODA 삭제 실패 — 행을 남기고 다시 지우기를 기다린다
--
-- 시각 칸 둘의 뜻이 다르다.
--   noda_read_started_at  '이번 읽기 시작' — 확인·다시 시도 때만 찍는다. 10분 포기 판정의 기준
--   noda_last_attempt_at  'NODA에 보낸 마지막 때' — 2분 다시 걸기 판정과 중복 방지(조건부 갱신)의 기준
-- noda_filename = '{document_id}__{원래 파일 이름}' (NODA 보관함 안의 이름). 유일하다.
-- =============================================================

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS noda_status text CHECK (noda_status IN ('reading','ready','failed','unreadable','deleting')),
  ADD COLUMN IF NOT EXISTS noda_reason text,
  ADD COLUMN IF NOT EXISTS noda_filename text UNIQUE,
  ADD COLUMN IF NOT EXISTS noda_doc_id text,
  ADD COLUMN IF NOT EXISTS noda_read_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS noda_last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS noda_read_at timestamptz;

CREATE INDEX IF NOT EXISTS documents_agent_noda_status_idx ON documents(agent_id, noda_status);

COMMENT ON COLUMN documents.noda_status IS
  'NODA 읽기 상태. NULL = 옮기기 전 문서';
COMMENT ON COLUMN documents.noda_read_started_at IS
  '이번 읽기를 시작한 때(확인·다시 시도). 10분 포기 판정의 기준';
COMMENT ON COLUMN documents.noda_last_attempt_at IS
  'NODA에 마지막으로 보낸 때. 2분 다시 걸기 판정·중복 차지의 기준';

-- ── 확인 ─────────────────────────────────────────────────────
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'documents' AND column_name LIKE 'noda\_%'
 ORDER BY column_name;
-- noda_doc_id · noda_filename · noda_last_attempt_at · noda_read_at · noda_read_started_at · noda_reason · noda_status 7행이어야 한다
