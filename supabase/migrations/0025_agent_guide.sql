-- 0025: 비서 사용 방법 · 대화 시작 가이드
--
-- 직원이 비서를 열었을 때 **무엇을 넣어야 하는지 알 수 없다**는 것이 도입
-- 단계에서 가장 자주 막히는 지점이다. 비서마다 필요한 입력이 다르다 —
-- 공문 초안은 '주요 내용'을, 회의록 정리는 '녹취 전문'을, 민원인 답변은
-- '민원 내용과 우리 방침'을 줘야 한다.
--
-- 시스템 프롬프트에 적어도 모델만 알 뿐 화면에는 안 보인다. 설명(description)은
-- 목록 카드에 들어가는 한 줄이라 사용법을 담기에 짧다.
--
-- **관리자가 직접 적는 필드로 둔다.** 기관마다 넣을 내용이 다르기 때문이다.
-- 코드가 대신 지어내면 어느 기관에도 안 맞는 문장이 된다.

ALTER TABLE agents
  -- "어떤 직무를 채용하는지 알려주세요" 같은 안내. 대화 시작 화면에 보인다.
  ADD COLUMN IF NOT EXISTS usage_guide text,
  -- 눌러서 바로 시작할 수 있는 예시 입력. 빈 화면 앞에서 첫 문장을 못 쓰는
  -- 사람을 위한 것이다.
  ADD COLUMN IF NOT EXISTS starter_prompts text[];

COMMENT ON COLUMN agents.usage_guide IS
  '직원에게 보여줄 사용 방법. 대화 시작 화면에 표시된다. NULL이면 description만 보인다.';
COMMENT ON COLUMN agents.starter_prompts IS
  '예시 입력 목록. 눌러서 바로 입력창에 채운다. NULL 또는 빈 배열이면 표시하지 않는다.';
