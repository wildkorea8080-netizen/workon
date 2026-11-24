-- =============================================================
-- 0098_org_share_switch.sql
-- 기관 전체 '대화 공개 링크' 스위치 — 기관 전체 관리자가 직원의 대화 공개 공유를 한 번에 막고 다시 연다
--
-- 배경:
--   직원은 대화를 로그인 없이 열리는 링크로 공유할 수 있고(share_token), 관리자는 공유 중인 링크를 보고 하나씩 멈출 수 있다
--   (2026-11-18). 그러나 기관이 공개 공유 자체를 막을 길이 없었다 — 외부 공개 링크를 금지하는 보안 정책의 기관도
--   직원이 새 링크를 만들 수 있었다.
--
-- 칸:
--   conversation_share_disabled_at     — 막은 시각. NULL = 열림(지금과 같음)
--   conversation_share_disabled_reason — 막은 까닭(관리자가 적은 5~200자를 다듬어 저장). 막은 동안만 있다
--
-- 막으면: 새 공개 링크를 만들 수 없고(403), 이미 만든 링크도 열리지 않는다(공개 조회 403 — 링크·토큰은 지우지 않아
--        다시 열면 그대로 열린다. 영영 닫으려면 관리자 '공유 중단'이나 직원의 공유 중단). 바꾸기는 security_logs(코드).
--
-- 추가만. 여러 번 적용해도 안전.
-- **코드 배포 전에 적용** — 새 코드가 공유 만들기·공개 조회·관리자 화면에서 이 칸을 읽는다.
-- 칸을 읽지 못하면 공유 만들기와 공개 조회는 503(닫힘)이다.
-- =============================================================

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS conversation_share_disabled_at timestamptz,
  ADD COLUMN IF NOT EXISTS conversation_share_disabled_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_conversation_share_switch_check'
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_conversation_share_switch_check
      CHECK (
        (conversation_share_disabled_at IS NULL) = (conversation_share_disabled_reason IS NULL)
        AND (conversation_share_disabled_reason IS NULL OR char_length(conversation_share_disabled_reason) BETWEEN 1 AND 300)
      );
  END IF;
END $$;
