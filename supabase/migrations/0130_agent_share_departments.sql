-- 0130: 나만의 비서를 부서 단위로 함께 쓰기(2026-11-26) — src/lib/agent-permissions.ts, src/lib/agent-shares.ts, docs/benchmarks/allganize/AGENT_SHARES.md
-- 0128은 사람 단위였다. 주인이 같은 기관의 부서를 골라(20곳까지) 그 부서와 하위 부서 사람 모두가 쓰게 한다(쓰기만 — 고치기는 사람 단위
-- '함께 고치기'만). 부서 비서로 올리지 않고도 함께 쓴다(올리면 부서원 누구나 고치고 되돌릴 수 없다). 판정은 canUseAgent 한 곳.
-- 추가만, 여러 번 적용해도 안전. **0129 뒤·코드 배포 전에 반드시 적용** — 비서 권한 select에 이 칸이 들어간다.

ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS shared_department_ids uuid[] NOT NULL DEFAULT '{}';

ALTER TABLE public.agents DROP CONSTRAINT IF EXISTS agents_shared_department_ids_check;
ALTER TABLE public.agents ADD CONSTRAINT agents_shared_department_ids_check CHECK (cardinality(shared_department_ids) <= 20);

CREATE INDEX IF NOT EXISTS agents_shared_department_ids_idx ON public.agents USING gin (shared_department_ids);

NOTIFY pgrst, 'reload schema';
