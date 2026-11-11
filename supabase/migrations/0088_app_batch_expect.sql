-- 0088: 앱 일괄 실행의 기대 핵심어(src/lib/apps/batches.ts) — 앱 답변을 여러 건 한 번에 재는 길.
--
-- 직원이 일괄 실행 표에 '기대 핵심어' 칸을 두면 줄마다 그 글을 expect에 저장하고, 실행기가 줄을 마칠 때 그 실행의 답변 글에
-- 핵심어(쉼표·세미콜론·가운뎃점으로 나눔)가 모두 있는지 한 번 재 결과에 없던 핵심어를 expect_missing에 둔다(빈 배열 = 모두 있음, NULL = 재지 않음).
-- 모델을 부르지 않는다 — 문서 찾기 평가의 '기대 답 핵심어'와 같은 규칙(src/lib/keyword-match.ts).
-- 추가만, 여러 번 적용해도 안전. **코드 배포 전에 적용** — 새 코드의 실행기·목록이 이 칸을 select 해, 없으면 일괄 실행이 돌지 않는다.
ALTER TABLE public.app_batch_items ADD COLUMN IF NOT EXISTS expect text;
ALTER TABLE public.app_batch_items ADD COLUMN IF NOT EXISTS expect_missing text[];
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_batch_items_expect_check') THEN
    ALTER TABLE public.app_batch_items ADD CONSTRAINT app_batch_items_expect_check CHECK (expect IS NULL OR char_length(expect) BETWEEN 1 AND 500);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_batch_items_expect_missing_check') THEN
    ALTER TABLE public.app_batch_items ADD CONSTRAINT app_batch_items_expect_missing_check
      CHECK (expect_missing IS NULL OR (expect IS NOT NULL AND cardinality(expect_missing) <= 20));
  END IF;
END $$;
