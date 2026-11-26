-- 0128: 나만의 비서·앱 함께 쓰기(2026-11-26) — src/lib/agent-permissions.ts, src/lib/agent-shares.ts, docs/benchmarks/allganize/AGENT_SHARES.md
-- 나만의 비서(입력형 앱 포함)는 만든 사람만 썼다. 주인이 같은 기관의 동료를 20명까지 골라 함께 쓰게 한다(쓰기만 — 고치기·지우기·
-- 공유 바꾸기는 주인만). 권한 판정(canUseAgent)이 이 칸을 읽으므로 대화·앱 실행·예약·연동·일괄 실행이 모두 같은 규칙을 탄다.
-- 공유는 운영 값이라 판을 남기지 않는다(보안 로그 agent_shared). 부서 비서로 올려도 칸은 남지만 부서 비서의 판정은 이 칸을 보지 않는다.
-- 추가만, 여러 번 적용해도 안전. **코드 배포 전에 반드시 적용** — 새 코드가 비서 권한을 읽을 때 이 칸을 select 해, 없으면 비서를 읽지 못한다.

ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS shared_user_ids uuid[] NOT NULL DEFAULT '{}';

ALTER TABLE public.agents DROP CONSTRAINT IF EXISTS agents_shared_user_ids_check;
ALTER TABLE public.agents ADD CONSTRAINT agents_shared_user_ids_check CHECK (cardinality(shared_user_ids) <= 20);

-- 공유받은 비서 목록(shared_user_ids @> {나})
CREATE INDEX IF NOT EXISTS agents_shared_user_ids_idx ON public.agents USING gin (shared_user_ids);

NOTIFY pgrst, 'reload schema';
