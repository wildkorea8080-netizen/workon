-- 0096: 직원 비밀번호 찾기 — 메일 재설정 링크 (2026-11-16)
--
-- 비밀번호를 잊은 직원이 관리자를 거치지 않고 다시 들어오는 길. 로그인 화면 '비밀번호를 잊으셨나요?'에 이메일을 넣으면
-- 그 주소가 쓸 수 있는 직원 계정일 때만 30분짜리 재설정 링크를 메일로 보낸다(src/lib/password-reset-mail.ts).
-- - 계정이 있든 없든 화면 응답은 같다(어떤 주소가 등록돼 있는지 알아내는 통로가 되지 않게). 그래서 계정이 없는 요청도
--   한 줄(user_id NULL)을 남겨 IP마다 1시간 요청 수를 센다.
-- - 링크의 열쇠는 원문을 저장하지 않고 SHA-256만(token_hash). 한 번 쓰면 used_at, 새로 요청하면 앞 링크는 끝난다.
-- - IP도 해시만(ip_hash).
-- 추가만, 여러 번 적용해도 안전, RLS 켜고 정책 없음·공개 키 권한 없음(서비스 키만).
-- 코드 배포 전에 적용 — 없으면 비밀번호 찾기 요청·재설정만 실패한다(로그인은 그대로).

CREATE TABLE IF NOT EXISTS public.password_reset_requests (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid REFERENCES public.users(id) ON DELETE CASCADE,
  token_hash text UNIQUE CHECK (token_hash IS NULL OR token_hash ~ '^[0-9a-f]{64}$'),
  ip_hash    text CHECK (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- 계정이 있는 요청만 열쇠·기한이 있다(없는 요청은 세기용 한 줄)
  CONSTRAINT password_reset_requests_shape_check CHECK (
    (user_id IS NULL AND token_hash IS NULL AND expires_at IS NULL AND used_at IS NULL)
    OR (user_id IS NOT NULL AND token_hash IS NOT NULL AND expires_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS password_reset_requests_user_idx ON public.password_reset_requests (user_id, created_at) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS password_reset_requests_ip_idx ON public.password_reset_requests (ip_hash, created_at) WHERE ip_hash IS NOT NULL;

ALTER TABLE public.password_reset_requests ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON public.password_reset_requests FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON public.password_reset_requests FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.password_reset_requests TO service_role';
  END IF;
END $$;
