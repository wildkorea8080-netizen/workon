-- 0074: 앱 예약의 자동 이어 실행 (src/lib/apps/schedules.ts)
--
-- 예약 실행이 처리 시간 예산(실행기 한 번 200초)에 닿아 멈추면, 끝난 단계가 남은 기록(입력만 쓰는 앱)을 다음 실행기 차례(약 5분 뒤)에
-- 손 '이어 실행'과 같은 길(`resume_message_id`)로 이어 간다 — 다음 정해진 시각에 처음부터 다시 하지 않는다.
-- resume_message_id = 이어 갈 멈춘 답변 메시지(그 직원의 대화). 외래 키는 두지 않는다 — 대화를 지우면 이어 실행이 404로 거절되고 실행기가 처음부터 다시 한다.
-- resume_count = 이번 차례에서 이어 간 횟수(상한은 코드 SCHEDULE_MAX_RESUMES). 완료·실패·고치기·다시 켜기에서 0으로.
-- 추가만. 여러 번 적용해도 안전. 코드 배포 전에 적용 — 새 코드가 실행 결과를 저장할 때 이 칸을 쓴다(없으면 결과 저장이 실패해 차지가 15분 남는다).
ALTER TABLE public.app_schedules ADD COLUMN IF NOT EXISTS resume_message_id uuid;
ALTER TABLE public.app_schedules ADD COLUMN IF NOT EXISTS resume_count smallint NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_schedules_resume_count_range') THEN
    ALTER TABLE public.app_schedules ADD CONSTRAINT app_schedules_resume_count_range CHECK (resume_count BETWEEN 0 AND 10);
  END IF;
END $$;

COMMENT ON COLUMN public.app_schedules.resume_message_id IS '처리 시간 예산에 멈춘 실행을 다음 실행기 차례에 이어 갈 답변 메시지(0074) — 없으면 평소 실행';
COMMENT ON COLUMN public.app_schedules.resume_count IS '이번 차례에서 이어 간 횟수(0074)';

NOTIFY pgrst, 'reload schema';
