-- =============================================================
-- 0070_org_schedule_switch.sql
-- 기관 전체 앱 예약 스위치 — 기관 전체 관리자가 입력형 앱 예약 실행을 한 번에 멈추고 다시 켠다
--
-- 배경:
--   0068로 외부 연동은 기관 전체를 한 번에 끌 수 있게 됐지만 예약은 0050의 '하나씩 멈춤'뿐이었다.
--   비용 점검·모델 장애·사고 대응으로 "지금 기관의 예약 실행을 모두 멈춰야" 할 때 한 번에 거는 길이 없었다.
--
-- 칸:
--   app_schedules_disabled_at     — 끈 시각. NULL = 켜짐(지금과 같음)
--   app_schedules_disabled_reason — 끈 까닭(관리자가 적은 5~200자를 다듬어 저장). 끈 동안만 있다
--
-- 끄면: 실행기는 그 기관의 예약을 실행하지 않고 다음 차례로 넘긴다(실패로 세지 않음·모델 호출 없음). 새 예약은 만들 수 없다.
--       직원의 예약 설정은 그대로다 — 다시 켜면 다음 차례부터 돈다. 바꾸기는 security_logs에 남는다(코드).
--
-- 추가만. 여러 번 적용해도 안전.
-- **코드 배포 전에 적용** — 새 코드가 실행기·예약 만들기·목록에서 이 칸을 읽는다.
-- 칸을 읽지 못하면 실행기는 그 차례를 잡지 않고 다음 호출에 다시 보며(실행하지도 넘기지도 않음), 예약 만들기는 503이다.
-- =============================================================

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS app_schedules_disabled_at timestamptz,
  ADD COLUMN IF NOT EXISTS app_schedules_disabled_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_app_schedules_switch_check'
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_app_schedules_switch_check
      CHECK (
        (app_schedules_disabled_at IS NULL) = (app_schedules_disabled_reason IS NULL)
        AND (app_schedules_disabled_reason IS NULL OR char_length(app_schedules_disabled_reason) BETWEEN 1 AND 300)
      );
  END IF;
END $$;
