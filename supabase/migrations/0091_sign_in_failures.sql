-- 0091: 로그인 실패 기록 — 계정·IP 잠금 (2026-11-13)
--
-- 로그인 실패를 세지 않아 비밀번호를 끝없이 맞춰 볼 수 있었다(관리자가 등록해 password_hash로 들어오는 계정은
-- Supabase Auth의 횟수 제한도 거치지 않는다). 직원 로그인·슈퍼관리자 로그인이 실패마다 한 줄을 남기고,
-- 한 계정이 30분 안에 5번 틀리면(또는 한 IP가 30번) 잠근다(src/lib/sign-in-throttle.ts). 성공하면 그 계정의 줄을 지운다.
-- 이메일·IP는 그대로 두지 않고 SHA-256만. 추가만, 여러 번 적용해도 안전, RLS 켜고 정책 없음(서비스 키만).
-- 코드 배포 전에 적용이 좋다 — 없으면 실패를 세지 못해 잠금만 없다(로그인은 그대로 된다).

CREATE TABLE IF NOT EXISTS public.sign_in_failures (
  id         bigserial PRIMARY KEY,
  scope      text NOT NULL CHECK (scope IN ('user', 'super')),
  key_hash   text NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  ip_hash    text CHECK (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sign_in_failures_key_idx ON public.sign_in_failures (scope, key_hash, created_at);
CREATE INDEX IF NOT EXISTS sign_in_failures_ip_idx ON public.sign_in_failures (scope, ip_hash, created_at) WHERE ip_hash IS NOT NULL;

ALTER TABLE public.sign_in_failures ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON public.sign_in_failures FROM anon';
    EXECUTE 'REVOKE ALL ON SEQUENCE public.sign_in_failures_id_seq FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON public.sign_in_failures FROM authenticated';
    EXECUTE 'REVOKE ALL ON SEQUENCE public.sign_in_failures_id_seq FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT SELECT, INSERT, DELETE ON public.sign_in_failures TO service_role';
    EXECUTE 'GRANT USAGE ON SEQUENCE public.sign_in_failures_id_seq TO service_role';
  END IF;
END $$;
