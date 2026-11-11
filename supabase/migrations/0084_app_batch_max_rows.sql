-- 0084: 기관 전체 관리자가 정하는 입력형 앱 일괄 실행 한 번의 최대 줄 수(2026-11-10) — src/lib/apps/batch-limit.ts, docs/benchmarks/allganize/APP_BATCHES.md
-- NULL이면 기본 상한(100줄 — BATCH_MAX_ROWS). 줄마다 AI 사용량이 들어 비용 통제용으로 기관이 낮출 수 있다(1~100).
-- 이미 만든 일괄 실행은 그대로 돈다(만들 때만 본다). 바꾸면 보안 로그(high).
-- 추가만(칸 하나·CHECK). 여러 번 적용해도 안전. 코드 배포 전에 적용 — 새 코드가 일괄 실행을 만들 때 이 칸을 읽어, 없으면 만들기가 503으로 닫힌다.
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS app_batch_max_rows smallint;

ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_app_batch_max_rows_check;
ALTER TABLE public.organizations ADD CONSTRAINT organizations_app_batch_max_rows_check
  CHECK (app_batch_max_rows IS NULL OR app_batch_max_rows BETWEEN 1 AND 100);

NOTIFY pgrst, 'reload schema';
