-- =============================================================
-- 0068_org_webhook_switch.sql
-- 기관 전체 외부 연동(Webhook) 스위치 — 기관 전체 관리자가 입력형 앱 외부 연동을 한 번에 끄고 켠다
--
-- 배경:
--   0049의 연동 토큰은 외부 시스템이 직원 권한으로 앱을 돌리게 하는 자격이다. 0050으로 관리자가 토큰을
--   하나씩 회수할 수 있지만, 보안 점검·사고 대응·기관 정책으로 "지금 기관의 외부 호출을 모두 막아야" 할 때
--   한 번에 끄는 길이 없었다(APP_WEBHOOKS.md '알려진 한계').
--
-- 칸:
--   app_webhooks_disabled_at     — 끈 시각. NULL = 켜짐(지금과 같음)
--   app_webhooks_disabled_reason — 끈 까닭(관리자가 적은 5~200자를 다듬어 저장). 끈 동안만 있다
--
-- 끄면: 외부 호출은 차지(간격·하루 상한·사용 횟수) 전에 403으로 거절되고, 새 연동을 만들 수 없다.
--       토큰은 회수하지 않는다 — 다시 켜면 그대로 쓴다. 바꾸기는 security_logs에 남는다(코드).
--
-- 추가만. 여러 번 적용해도 안전.
-- **코드 배포 전에 적용** — 새 코드가 연동 호출·만들기·목록에서 이 칸을 읽는다.
-- 칸이 없으면 외부 호출은 500(닫힘)·연동 만들기는 503이고, 그 밖의 기능에는 영향이 없다.
-- =============================================================

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS app_webhooks_disabled_at timestamptz,
  ADD COLUMN IF NOT EXISTS app_webhooks_disabled_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_app_webhooks_switch_check'
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_app_webhooks_switch_check
      CHECK (
        (app_webhooks_disabled_at IS NULL) = (app_webhooks_disabled_reason IS NULL)
        AND (app_webhooks_disabled_reason IS NULL OR char_length(app_webhooks_disabled_reason) BETWEEN 1 AND 300)
      );
  END IF;
END $$;
