-- 0118: 기관 SSO 세션 번호(sid) → 직원 (2026-11-25)
--
-- back-channel 로그아웃(0114)은 logout_token의 sub로 직원을 찾았다. OIDC Back-Channel Logout 1.0은 sub와 sid 중 하나만 보내도 되고,
-- sid만 보내는 계정 서비스도 있다(그동안 그런 토큰은 400으로 거절했다). 기관 계정으로 로그인할 때 id_token에 sid가 있으면
-- 기관·발급자·sid → 직원을 적어 두고, sid만 온 logout_token이면 그 직원의 그 전 기관 계정 로그인을 끝낸다(src/lib/org-sso.ts).
-- WORKON 로그인에 sid를 싣지 않으므로 그 세션 하나가 아니라 그 직원의 기관 계정 로그인을 모두 끝낸다(sub가 왔을 때와 같다).
-- 줄은 로그인 때 그 직원의 31일 넘은 줄을 치운다(WORKON 기관 계정 로그인은 30일).
--
-- 추가만, 여러 번 적용해도 안전, 새 표는 RLS 켜고 정책 없음·공개 키 권한 없음.
-- **코드 배포 전에 적용** — 없으면 로그인 때 sid를 적지 못하고(운영 기록에 남고 로그인은 그대로) sid만 온 로그아웃이 503으로 돌아간다.

CREATE TABLE IF NOT EXISTS public.org_sso_sessions (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  issuer          text NOT NULL CHECK (char_length(issuer) BETWEEN 1 AND 500),
  sid             text NOT NULL CHECK (char_length(sid) BETWEEN 1 AND 255),
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, issuer, sid)
);

CREATE INDEX IF NOT EXISTS org_sso_sessions_user_idx ON public.org_sso_sessions (user_id, created_at);

ALTER TABLE public.org_sso_sessions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON public.org_sso_sessions FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON public.org_sso_sessions FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.org_sso_sessions TO service_role';
  END IF;
END $$;
