-- =============================================================
-- 0019_agent_catalog.sql
-- 비서 카탈로그 — 노출 스위치 / 정렬 순서 / 카테고리 / 링크형 비서
--
-- 배경:
--   비서가 늘어날수록 직원 화면에서 찾기가 어려워진다. 지금은 11개라
--   한 덩어리로 보여도 되지만, 공공 비서 8종에 기관별 비서가 붙으면
--   금방 수십 개가 된다.
--
--   category / icon 컬럼은 이미 있었지만 관리자 화면에서 쓰지 못했다.
--   직원용 '나만의 비서' 폼에는 두 입력이 있는데 관리자용 공식 비서
--   폼에만 빠져 있어서, 관리자가 만든 비서는 아이콘 없이 '전체'
--   카테고리로만 쌓였다. 화면 작업과 함께 이 비대칭을 없앤다.
--
-- 공개 범위(visibility)와 카테고리의 역할을 분리한다:
--   visibility  = 누가 볼 수 있는가 (권한)
--   category    = 어디에 묶여 보이는가 (표시 분류)
--   is_published= 지금 내보내는가 (노출 스위치)
--
--   카테고리에 권한을 얹지 않는 이유는, 얹는 순간 "카테고리는 공개인데
--   비서는 비공개" 같은 모순 상태가 생기고 어느 쪽이 이기는지를 매번
--   판단해야 하기 때문이다. 권한의 근거는 visibility 하나로 둔다.
-- =============================================================

-- ── 1. 노출 스위치 ───────────────────────────────────────────
-- 관리자가 비서를 만들어 두고 공개 전에 직접 써 보는 단계가 필요하다.
-- 직원 신청 → 관리자 승인(approval_status)과는 다른 축이다.
--   approval_status : 직원이 올린 것을 받아줄 것인가
--   is_published    : 지금 직원 화면에 내보낼 것인가
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS is_published boolean NOT NULL DEFAULT true;

-- 기존 비서는 이미 쓰이고 있으므로 위 DEFAULT true로 그대로 남는다.
-- 앞으로 만드는 비서는 '노출 대기중'에서 시작하도록 기본값을 뒤집는다.
ALTER TABLE agents
  ALTER COLUMN is_published SET DEFAULT false;

COMMENT ON COLUMN agents.is_published IS
  '직원 화면 노출 여부. false면 관리자에게만 보이는 노출 대기중 상태.';


-- ── 2. 정렬 순서 ─────────────────────────────────────────────
-- 값이 같으면 이름순으로 떨어지게 조회 쪽에서 정렬을 이어 붙인다.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS display_order integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN agents.display_order IS
  '카테고리 안에서의 노출 순서. 작을수록 앞. 동률이면 이름순.';


-- ── 3. 링크형 비서 ───────────────────────────────────────────
-- 기관이 이미 쓰는 시스템(그룹웨어, 문서24, 업무포털)을 비서 목록에
-- 함께 얹어 한 화면에서 출발하게 한다. 대화형이 아니라 새 탭으로 연결만 한다.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS agent_type text NOT NULL DEFAULT 'chat';

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS link_url text;

-- 'type'이 아니라 'agent_type'인 이유: PostgREST 예약어와 겹치지 않게 하고
-- 클라이언트 쪽 TS 타입에서도 의미가 드러나게 한다.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agents_agent_type_check'
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_agent_type_check
      CHECK (agent_type IN ('chat', 'link'));
  END IF;

  -- 링크형인데 주소가 없으면 클릭했을 때 아무 일도 안 일어난다.
  -- 반대로 대화형에 주소가 남아 있으면 나중에 유형만 바꿨을 때 오동작한다.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agents_link_url_check'
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_link_url_check
      CHECK (
        (agent_type = 'link' AND link_url IS NOT NULL AND length(trim(link_url)) > 0)
        OR
        (agent_type = 'chat' AND link_url IS NULL)
      );
  END IF;
END $$;

COMMENT ON COLUMN agents.agent_type IS
  'chat=대화형, link=외부 링크 연결형(새 탭). link면 link_url 필수.';


-- ── 4. 카테고리 ──────────────────────────────────────────────
-- agents.category는 지금 자유 텍스트다('공공기관', '전체'). 그대로 두면
-- 이름 변경·순서 조정을 할 곳이 없으므로 기관별 카테고리 표를 둔다.
--
-- agents.category를 FK로 바꾸지 않고 이름(text)으로 남기는 이유:
-- 기존 행을 건드리지 않고 도입할 수 있고, 카테고리를 지우더라도 비서가
-- 사라지지 않고 '미분류'로 떨어지기 때문이다.
CREATE TABLE IF NOT EXISTS agent_categories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  display_order   integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 기관마다 독립이다. 이름만으로 유일성을 걸면 타 기관의 '업무' 카테고리와
-- 충돌한다 — 0014에서 부서에 대해 겪은 것과 같은 문제다.
CREATE UNIQUE INDEX IF NOT EXISTS agent_categories_org_name_idx
  ON agent_categories(organization_id, name);

CREATE INDEX IF NOT EXISTS idx_agent_categories_org
  ON agent_categories(organization_id, display_order);

COMMENT ON TABLE agent_categories IS
  '기관별 비서 카테고리. 표시 분류일 뿐 권한이 아니다(권한은 agents.visibility).';


-- ── 5. 기존 카테고리 백필 ────────────────────────────────────
-- 이미 쓰이고 있는 category 값을 그대로 표로 옮긴다. 화면에서 카테고리
-- 관리를 열었을 때 빈 목록이 아니라 지금 상태가 보여야 한다.
INSERT INTO agent_categories (organization_id, name, display_order)
SELECT DISTINCT a.organization_id, trim(a.category), 0
  FROM agents a
 WHERE a.organization_id IS NOT NULL
   AND a.category IS NOT NULL
   AND trim(a.category) <> ''
ON CONFLICT (organization_id, name) DO NOTHING;


-- ── 6. 조회 인덱스 ───────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_agents_catalog
  ON agents(organization_id, is_published, display_order);


-- ── 확인 ─────────────────────────────────────────────────────
SELECT
  a.category                                        AS 카테고리,
  count(*)                                          AS 비서수,
  count(*) FILTER (WHERE a.is_published)            AS 노출중,
  count(*) FILTER (WHERE a.agent_type = 'link')     AS 링크형,
  count(*) FILTER (WHERE a.icon IS NULL)            AS 아이콘없음
FROM agents a
GROUP BY a.category
ORDER BY a.category;
