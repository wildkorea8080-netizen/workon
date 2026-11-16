-- 0097: 운영 스키마와 코드가 어긋난 두 곳 메우기 (2026-11-16)
--
-- 0096 운영 확인 중에 찾았다. 코드는 오래전부터 아래 둘을 쓰는데 운영 DB에 없었다.
--
-- 1) users.password_hash — 관리자 등록·일괄 등록·초대 가입이 Supabase Auth 밖의 bcrypt 해시를 여기에 쓰고, 로그인의 두 번째 길이
--    읽는다(nextAuthOptions.ts). 칸을 만드는 마이그레이션이 없었다(대시보드에서 만든 개발 DB에만 있었던 것으로 보인다).
--    없으면 select·update가 42703으로 실패한다 — 그래서 운영에서 '내 비밀번호 바꾸기'·관리자 임시 비밀번호 재발급(Auth 비밀번호만 바뀌고
--    오류)·비밀번호 찾기·관리자 직원 등록이 실패했다.
-- 2) security_logs — 0002가 만드는 표인데 운영 DB에는 없었다. 코드의 보안 로그 쓰기(금지어 차단·질문 원문 열람·계정 사용 중지·비밀번호
--    바꾸기 등)는 오류를 삼켜 조용히 사라졌고, 감사 화면 '보안 이벤트'는 읽지 못했다. 0002와 같은 꼴로 만든다.
--
-- 추가만, 여러 번 적용해도 안전. 새 표는 RLS 켜고 정책 없음·공개 키 권한 없음(0090 원칙). users는 0090으로 이미 RLS가 켜져 있다.

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_hash text;

CREATE TABLE IF NOT EXISTS public.security_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  severity text NOT NULL DEFAULT 'medium',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS security_logs_department_id_idx ON public.security_logs (department_id);
CREATE INDEX IF NOT EXISTS security_logs_user_id_idx ON public.security_logs (user_id);
CREATE INDEX IF NOT EXISTS security_logs_event_type_idx ON public.security_logs (event_type);
CREATE INDEX IF NOT EXISTS security_logs_severity_idx ON public.security_logs (severity);
CREATE INDEX IF NOT EXISTS security_logs_created_at_idx ON public.security_logs (created_at);

ALTER TABLE public.security_logs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON public.security_logs FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON public.security_logs FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.security_logs TO service_role';
  END IF;
END $$;
