-- 0119: 앱 예약의 시간대 (2026-11-25)
--
-- 입력형 앱 예약(0048)은 한국 시간에 고정돼 있었다. 해외 사무소·주재관 직원이 그곳 시각(예: 뉴욕 오전 9시)으로 예약하도록
-- 예약마다 IANA 시간대를 둔다. 고를 수 있는 시간대는 코드가 본다(src/lib/apps/schedule-spec.ts `isScheduleTimeZone` — 자주 쓰는 목록 + IANA 정식 이름),
-- 다음 실행 시각은 그 시간대의 벽시계로 셈한다(서머타임은 IANA 자료로 — 없는 시각이면 한 시간 뒤, 두 번 오는 시각이면 앞의 것).
-- 기존 예약은 'Asia/Seoul'로 채워져 그대로 돈다. 시간대는 자주 쓰는 목록 밖에서도 실행 환경(Intl)이 아는 IANA 정식 이름이면 받는다(코드가 본다).
-- 같은 날 실행 시각의 분을 00·30분에서 **5분 단위**(0~55)로 넓힌다 — 실행기가 5분마다 돈다(0048의 run_minute CHECK를 바꿈).
-- 추가만, 여러 번 적용해도 안전. **코드 배포 전에 적용** — 새 코드가 예약 목록·만들기·실행기에서 이 칸을 읽고 써서, 없으면 앱 예약 화면이 503.

ALTER TABLE public.app_schedules
  ADD COLUMN IF NOT EXISTS time_zone text NOT NULL DEFAULT 'Asia/Seoul';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_schedules_time_zone_check') THEN
    ALTER TABLE public.app_schedules
      ADD CONSTRAINT app_schedules_time_zone_check CHECK (time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$' AND char_length(time_zone) <= 64);
  END IF;
END $$;

-- 실행 시각의 분 — 0~55, 5분 단위
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'public.app_schedules'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) ILIKE '%run_minute%' AND conname <> 'app_schedules_run_minute_5_check'
  LOOP
    EXECUTE format('ALTER TABLE public.app_schedules DROP CONSTRAINT %I', c.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_schedules_run_minute_5_check') THEN
    ALTER TABLE public.app_schedules
      ADD CONSTRAINT app_schedules_run_minute_5_check CHECK (run_minute BETWEEN 0 AND 55 AND run_minute % 5 = 0);
  END IF;
END $$;
