-- 0114: 기관 SSO back-channel 로그아웃(2026-11-25)
--
-- 직원이 계정 서비스(Keycloak·Okta·Auth0 등 OIDC)에서 먼저 로그아웃하거나 관리자가 그쪽 세션을 끊으면, 계정 서비스가 WORKON의
-- POST /api/sso/backchannel-logout 으로 서명한 logout_token(OIDC Back-Channel Logout 1.0)을 보낸다. WORKON은 그 직원의
-- '기관 계정 로그아웃 시각'(users.sso_logout_at)을 적고, 미들웨어가 그 전에 기관 계정으로 들어온 WORKON 로그인을 끝낸다
-- (src/lib/org-sso.ts `handleBackchannelLogout`, src/lib/middleware-db.ts `userSessionVerdict` — 'sso_logged_out').
--
-- logout_token에는 이메일이 없고 계정 서비스의 사용자 번호(sub)만 오므로, 기관 계정으로 로그인할 때 sub → 직원을 적어 둔다
-- (org_sso_subjects — 기관·발급자·sub마다 한 줄). 비밀번호 로그인·대리 접근은 끝내지 않는다. 같은 직원의 다른 기관 계정 로그인도
-- 모두 끝난다(세션 번호 sid는 적지 않음).
--
-- 추가만, 여러 번 적용해도 안전, 새 표는 RLS 켜고 정책 없음·공개 키 권한 없음.
-- **코드 배포 전에 반드시 적용** — 새 미들웨어가 모든 직원 요청에서 users.sso_logout_at을 select 해, 없으면 계정 상태를 못 읽어
-- 열림으로 돈다(비활성·탈퇴·권한 변경 끊기까지 빠진다).
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS sso_logout_at timestamptz;

CREATE TABLE IF NOT EXISTS public.org_sso_subjects (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  issuer          text NOT NULL CHECK (char_length(issuer) BETWEEN 1 AND 500),
  subject         text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 255),
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, issuer, subject)
);

CREATE INDEX IF NOT EXISTS org_sso_subjects_user_idx ON public.org_sso_subjects (user_id);

ALTER TABLE public.org_sso_subjects ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON public.org_sso_subjects FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON public.org_sso_subjects FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.org_sso_subjects TO service_role';
  END IF;
END $$;
