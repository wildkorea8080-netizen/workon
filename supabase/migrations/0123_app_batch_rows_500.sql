-- 0123: 입력형 앱 일괄 실행 한 번 최대 줄 수를 500까지(2026-11-26) — src/lib/apps/batch-spec.ts BATCH_ROWS_CEILING, docs/benchmarks/allganize/APP_BATCHES.md
-- 기본은 그대로 100줄(organizations.app_batch_max_rows가 NULL). 기관 전체 관리자가 정하면 500줄까지 한 번에 돌린다 — 실행기가 쌓인 줄이 많으면
-- 일괄 실행 전용 실행기를 몇 개 더 띄워 나란히 돌린다(코드). 값만 넓힘(묶음 줄 수·줄 번호·기관 상한 CHECK 1~100 → 1~500).
-- 여러 번 적용해도 안전. 코드 배포 전에 적용 — 없으면 100줄 넘는 일괄 실행·상한 저장만 실패한다(DB가 거절).

ALTER TABLE public.app_batches DROP CONSTRAINT IF EXISTS app_batches_total_check;
ALTER TABLE public.app_batches ADD CONSTRAINT app_batches_total_check CHECK (total BETWEEN 1 AND 500);

ALTER TABLE public.app_batch_items DROP CONSTRAINT IF EXISTS app_batch_items_position_check;
ALTER TABLE public.app_batch_items ADD CONSTRAINT app_batch_items_position_check CHECK (position BETWEEN 1 AND 500);

ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_app_batch_max_rows_check;
ALTER TABLE public.organizations ADD CONSTRAINT organizations_app_batch_max_rows_check
  CHECK (app_batch_max_rows IS NULL OR app_batch_max_rows BETWEEN 1 AND 500);

NOTIFY pgrst, 'reload schema';
