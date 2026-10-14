-- =============================================================
-- 0027_resync_doc_search.sql
-- 문서가 있는 비서의 doc_search 능력 재동기화 (S1-b 선행)
--
-- 0026 적용 뒤 S1-a 코드가 배포되기 전까지는 옛 업로드 코드가 돌았다. 그 코드는
-- enable_agent_capability를 부르지 않아, 그 사이에 문서를 받은 비서는
-- capabilities에 doc_search가 없다. S1-b의 실행기는 doc_search가 켜진 비서만
-- 문서를 검색하므로, 메우지 않으면 문서가 있어도 검색하지 않고 오류 없이
-- 근거 없는 답을 한다.
--
-- 배포 순서: 이 파일 → S1-b 코드. (S1-b 코드보다 먼저 적용한다.)
-- 다시 돌려도 안전하다(멱등): 켜진 비서는 대상에서 빠진다.
--
-- 판 기록에 doc_search가 켜진 적이 있는데 지금 없는 비서는 사람이 일부러 끈
-- 것이므로 되살리지 않는다. agents를 직접 UPDATE하지 않는다 — 판 번호와
-- agent_history 사본이 남도록 enable_agent_capability(save_agent)를 거친다.
-- actor는 NULL이다. 사람이 고친 것이 아니므로 updated_by를 바꾸지 않는다.
-- =============================================================

DO $$
DECLARE
  r       record;
  enabled integer := 0;
BEGIN
  FOR r IN
    SELECT a.id
      FROM agents a
     WHERE a.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM documents d WHERE d.agent_id = a.id)
       AND NOT (a.capabilities ? 'doc_search')
       AND NOT EXISTS (
             SELECT 1 FROM agent_history h
              WHERE h.agent_id = a.id
                AND h.snapshot IS NOT NULL
                AND h.snapshot -> 'capabilities' ? 'doc_search')
  LOOP
    PERFORM enable_agent_capability(r.id, 'doc_search', NULL);
    enabled := enabled + 1;
  END LOOP;

  RAISE NOTICE '0027: doc_search를 켠 비서 %개', enabled;
END $$;


-- ── 확인 ─────────────────────────────────────────────────────
-- 문서가 있는데 doc_search가 없는 살아 있는 비서 수에서, 그중 일부러 끈 것
-- (판 기록에 켜진 적 있음)을 빼면 0이어야 한다.
SELECT count(*)                                            AS 문서있고_찾기없음,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM agent_history h
          WHERE h.agent_id = a.id
            AND h.snapshot IS NOT NULL
            AND h.snapshot -> 'capabilities' ? 'doc_search')) AS 일부러_끈_것,
       count(*) - count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM agent_history h
          WHERE h.agent_id = a.id
            AND h.snapshot IS NOT NULL
            AND h.snapshot -> 'capabilities' ? 'doc_search')) AS 남은_차이
  FROM agents a
 WHERE a.deleted_at IS NULL
   AND EXISTS (SELECT 1 FROM documents d WHERE d.agent_id = a.id)
   AND NOT (a.capabilities ? 'doc_search');
