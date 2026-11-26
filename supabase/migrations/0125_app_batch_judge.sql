-- 0125: 앱 일괄 실행의 AI 채점(2026-11-26) — src/lib/apps/batch-judge.ts, src/lib/apps/batches.ts, docs/benchmarks/allganize/APP_BATCHES.md
-- 직원이 일괄 실행을 만들 때 'AI 채점'을 고르면(기대 답·핵심어 칸이 있을 때만) 실행기가 줄을 마칠 때 그 앱의 모델로 한 번 더 불러
-- 결과가 기대 답과 맞는지 맞음·일부·틀림과 이유를 남긴다(참고 — 핵심어 판정은 그대로). 채점하지 못했으면 등급 없이 이유만.
-- 추가만(칸 셋·CHECK). 여러 번 적용해도 안전. **코드 배포 전에 적용** — 새 코드의 실행기·목록이 이 칸을 select 해, 없으면 일괄 실행이 돌지 않는다.

ALTER TABLE public.app_batches ADD COLUMN IF NOT EXISTS judge boolean NOT NULL DEFAULT false;
ALTER TABLE public.app_batch_items ADD COLUMN IF NOT EXISTS judge_grade text;
ALTER TABLE public.app_batch_items ADD COLUMN IF NOT EXISTS judge_reason text;

ALTER TABLE public.app_batch_items DROP CONSTRAINT IF EXISTS app_batch_items_judge_grade_check;
ALTER TABLE public.app_batch_items ADD CONSTRAINT app_batch_items_judge_grade_check
  CHECK (judge_grade IS NULL OR judge_grade IN ('correct', 'partial', 'incorrect'));

ALTER TABLE public.app_batch_items DROP CONSTRAINT IF EXISTS app_batch_items_judge_reason_check;
ALTER TABLE public.app_batch_items ADD CONSTRAINT app_batch_items_judge_reason_check
  CHECK (judge_reason IS NULL OR char_length(judge_reason) BETWEEN 1 AND 300);

-- 채점은 기대 답이 있는 줄만, 등급이 있으면 이유도(빈 이유는 '이유 없음'으로 채운다)
ALTER TABLE public.app_batch_items DROP CONSTRAINT IF EXISTS app_batch_items_judge_expect_check;
ALTER TABLE public.app_batch_items ADD CONSTRAINT app_batch_items_judge_expect_check
  CHECK ((judge_grade IS NULL AND judge_reason IS NULL) OR (expect IS NOT NULL AND judge_reason IS NOT NULL));

NOTIFY pgrst, 'reload schema';
