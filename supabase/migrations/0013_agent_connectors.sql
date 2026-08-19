-- =============================================================
-- 0013_agent_connectors.sql
-- 에이전트별 외부 도구(커넥터) 사용 설정
--
-- 배경:
--   툴 실행 루프 도입 시 모든 에이전트에 모든 도구가 노출됐다.
--   음슴체 변환 비서에까지 국가법령정보 도구가 붙어 매 요청마다 툴 정의
--   토큰이 붙고 오호출 가능성도 생긴다.
--
--   커넥터 id 배열로 관리한다 (예: {'law'}). 툴 단위가 아니라 커넥터 단위인
--   이유는 관리자가 "국가법령정보를 쓸지"를 결정하지 "law_search를 쓸지"를
--   결정하지는 않기 때문이다.
--
--   기본값은 빈 배열 = 도구 사용 안 함. 관리자가 명시적으로 켜야 한다.
-- =============================================================

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS enabled_connectors text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN agents.enabled_connectors IS
  '이 에이전트가 사용할 커넥터 id 목록. 빈 배열이면 외부 도구를 쓰지 않는다.';

-- 조회는 항상 에이전트 단건이라 인덱스는 두지 않는다.

-- 확인
SELECT
  count(*)                                                   AS total_agents,
  count(*) FILTER (WHERE cardinality(enabled_connectors) > 0) AS with_connectors
FROM agents;
