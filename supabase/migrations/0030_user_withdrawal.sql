-- =============================================================
-- 0030_user_withdrawal.sql
-- 사용자 탈퇴 처리 (슈퍼관리자 '계정 삭제')
--
-- 배포 순서: 이 파일 → 코드. 코드가 이 칸에 쓰고 목록 조회가 이 칸으로 거른다.
--
-- 사용자 행을 지우지 않는다. conversations·messages·usage_logs·documents·agents 등이
-- users를 ON DELETE 없이(NO ACTION) 가리켜 대화나 사용 기록이 있는 사용자는 지울 수 없고,
-- 지울 수 있게 SET NULL로 바꾸면 사용 기록이 남아도 "누가 썼는지"가 영영 사라진다.
-- 사용 기록은 과금·감사 근거라(감사 대응: 특정 직원의 사용 내역 제출) 귀속을 남긴다.
--
-- 탈퇴 = deleted_at 도장 + is_active=false + 이메일을 비석 주소로 바꿈(같은 주소로 다시 가입 가능)
--        + 대화·생성 파일·개인 비서 정리 + Supabase Auth 계정 삭제. 이름·부서는 남는다.
-- =============================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

COMMENT ON COLUMN users.deleted_at IS
  '탈퇴 처리 시각. NULL이 아니면 로그인 불가·목록 제외. 행은 사용 기록의 귀속을 위해 남긴다';
