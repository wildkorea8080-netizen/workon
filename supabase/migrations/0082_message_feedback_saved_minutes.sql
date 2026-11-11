-- 0082: 답변 평가의 '줄인 시간'(2026-11-10) — 직원이 '도움됨'을 누를 때 이 답으로 줄인 시간을 고를 수 있다(10분·30분·1시간·2시간·반나절, 선택).
-- **직원의 자기 신고**이고 측정·추정이 아니다. 관리자 통계 '답변 평가'가 비서별 합과 고른 답 수를 보인다(src/lib/message-feedback-spec.ts, docs/benchmarks/allganize/ADOPTION_REPORT.md).
-- 추가만(칸 하나·CHECK). 여러 번 적용해도 안전. 코드 배포 전에 적용 — 새 코드가 평가를 저장·읽을 때 이 칸을 써서, 없으면 평가 저장·요약이 실패한다(대화는 평가 없이 돈다).
ALTER TABLE public.message_feedback ADD COLUMN IF NOT EXISTS saved_minutes smallint;

ALTER TABLE public.message_feedback DROP CONSTRAINT IF EXISTS message_feedback_saved_minutes_check;
ALTER TABLE public.message_feedback ADD CONSTRAINT message_feedback_saved_minutes_check
  CHECK (saved_minutes IS NULL OR (saved_minutes BETWEEN 1 AND 480 AND rating = 'up'));

NOTIFY pgrst, 'reload schema';
