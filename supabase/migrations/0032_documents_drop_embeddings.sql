-- =============================================================
-- 0032_documents_drop_embeddings.sql
-- 옛 임베딩 값을 비운다 — NODA로 옮긴 문서의 embedding·metadata.chunks (S4-b)
--
-- 설계: docs/superpowers/specs/2026-10-21-s4-noda-document-layer-design.md 8절
--
-- **되돌릴 수 없다.** 비운 값(Voyage 임베딩·청크 사본)은 다시 만들 수 없다 — 지금은 NODA가 읽기·색인을 맡고,
-- 코드는 이 값을 더 읽지 않는다(`embeddings.ts`·`rag.ts`·`document-processor.ts`는 S4-b에서 지웠다).
--
-- 적용 순서: S4-b 코드 푸시(배포 확인 — 이 파일 없이도 돈다) → 대화에서 문서 근거 답·스캔 PDF 첨부 확인
--   → `npm run noda:migrate -- --dry-run`이 0건인지(문서가 모두 NODA로 옮겨짐) 확인 → 이 파일 적용.
-- 이 파일은 사용자가 직접 적용한다. 옮긴 것을 확인하기 전에는 적용하지 않는다.
--
-- 대상은 noda_status 가 NULL 이 아닌 행뿐이다. 옮기기 전(noda_status NULL) 문서는 값을 건드리지 않는다.
-- 지우지 않는 것: `embedding` 칸 자체, `search_agent_chunks`·`search_document_chunks` RPC.
--   칸과 RPC를 지우는 일은 값이 모두 빈 것을 확인한 뒤 따로 정한다(이 파일은 값만 비운다).
-- =============================================================

UPDATE documents
   SET embedding = NULL,
       metadata  = metadata - 'chunks'
 WHERE noda_status IS NOT NULL
   AND (embedding IS NOT NULL OR metadata ? 'chunks');

-- 확인 (적용 뒤): 남은 행이 0이어야 한다. noda_status NULL 인 옛 행이 있으면 그 수만큼 남는다.
--   SELECT count(*) FROM documents WHERE embedding IS NOT NULL OR metadata ? 'chunks';
