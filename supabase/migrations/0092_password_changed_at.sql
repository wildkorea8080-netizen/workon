-- 0092: 비밀번호를 바꾼 때 (2026-11-16)
--
-- 직원 로그인은 30일짜리 토큰이라, 비밀번호를 바꾸거나 관리자가 임시 비밀번호를 다시 내줘도 다른 기기의 로그인이 그대로 남았다
-- (잃어버린 노트북·남이 본 비밀번호를 바꿔도 소용이 없었다). 바꾼 때를 users에 적고, 미들웨어가 그보다 먼저 로그인한 토큰을 끝낸다
-- (src/lib/middleware-db.ts userSessionVerdict). 추가만, 여러 번 적용해도 안전. users는 0090으로 이미 RLS가 켜져 있다.
-- 코드 배포 전에 적용 — 새 미들웨어가 이 칸을 읽어, 없으면 계정 상태를 못 읽고 열림(옛 규칙)으로 돌아 로그인 끝내기만 빠진다.

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;
