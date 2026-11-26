-- 0129: 나만의 비서 함께 고치기(2026-11-26) — src/lib/agent-permissions.ts, src/lib/agent-shares.ts, docs/benchmarks/allganize/AGENT_SHARES.md
-- 0128의 함께 쓰는 사람 가운데 주인이 고른 사람은 설정·문서·양식까지 고친다(canEditAgent). 지우기·공유 바꾸기·부서 비서로 올리기·
-- 공식 등록 신청은 그대로 주인만. 함께 고치는 사람은 함께 쓰는 사람 안에서만(CHECK) — 빼면 함께 빠진다.
-- 추가만, 여러 번 적용해도 안전. **코드 배포 전에 반드시 적용** — 비서 권한 select에 이 칸이 들어가, 없으면 비서를 읽지 못한다.

ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS shared_editor_ids uuid[] NOT NULL DEFAULT '{}';

ALTER TABLE public.agents DROP CONSTRAINT IF EXISTS agents_shared_editor_ids_check;
ALTER TABLE public.agents ADD CONSTRAINT agents_shared_editor_ids_check CHECK (shared_editor_ids <@ shared_user_ids);

NOTIFY pgrst, 'reload schema';
