-- 0126: 앱 일괄 실행의 사람 판정(2026-11-26) — src/lib/apps/batches.ts, src/lib/apps/batch-spec.ts, docs/benchmarks/allganize/APP_BATCHES.md
-- 일괄 실행을 만든 직원이 마친 줄마다 결과가 기대 답과 맞는지 맞음·일부·틀림을 직접 매긴다. AI 채점(0125)과 맞대
-- 채점자 일치율·AI가 후하게/짜게 본 줄·3×3 표를 센다(문서 찾기 평가의 사람 판정과 같은 셈, 모델 호출 없음).
-- 추가만(칸 둘·CHECK). 여러 번 적용해도 안전. **코드 배포 전에 적용** — 새 코드의 목록·결과 엑셀이 이 칸을 select 해, 없으면 일괄 실행 목록이 실패한다.

ALTER TABLE public.app_batch_items ADD COLUMN IF NOT EXISTS human_grade text;
ALTER TABLE public.app_batch_items ADD COLUMN IF NOT EXISTS human_graded_at timestamptz;

ALTER TABLE public.app_batch_items DROP CONSTRAINT IF EXISTS app_batch_items_human_grade_check;
ALTER TABLE public.app_batch_items ADD CONSTRAINT app_batch_items_human_grade_check
  CHECK (human_grade IS NULL OR human_grade IN ('correct', 'partial', 'incorrect'));

-- 등급과 매긴 때는 짝, 매기는 줄은 마친 줄만
ALTER TABLE public.app_batch_items DROP CONSTRAINT IF EXISTS app_batch_items_human_pair_check;
ALTER TABLE public.app_batch_items ADD CONSTRAINT app_batch_items_human_pair_check
  CHECK ((human_grade IS NULL AND human_graded_at IS NULL) OR (human_grade IS NOT NULL AND human_graded_at IS NOT NULL AND status = 'done'));

NOTIFY pgrst, 'reload schema';
