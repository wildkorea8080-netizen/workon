-- 0107: 기관 SSO — OpenID Connect(2026-11-25)
--
-- 기관마다 계정 서비스 하나(Microsoft Entra ID·Google Workspace·Keycloak·사내 SSO)를 적어 두면, 기관 전용 로그인(/signin/{slug})에
-- '기관 계정으로 로그인' 단추가 생기고 인가 코드 + PKCE로 로그인한다(src/lib/org-sso.ts).
-- - 계정을 만들지 않는다 — 이 기관 부서에 이미 등록된 직원을 이메일로 찾을 때만 들어온다(소속·역할은 users 행만 정한다).
-- - 클라이언트 비밀값은 AES(crypto.ts)로만 저장하고 화면·기록에 내보내지 않는다.
-- - email_domains가 있으면 그 도메인의 이메일만 받는다.
-- 추가만, 여러 번 적용해도 안전, RLS 켜고 정책 없음·공개 키 권한 없음. 코드 배포 전에 적용 — 없으면 SSO 설정·단추만 없다(비밀번호 로그인은 그대로).

CREATE TABLE IF NOT EXISTS public.org_sso_providers (
  organization_id          uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  issuer                   text NOT NULL CHECK (issuer LIKE 'https://%' AND char_length(issuer) <= 500),
  client_id                text NOT NULL CHECK (char_length(client_id) BETWEEN 1 AND 200),
  client_secret_encrypted  text,
  email_domains            text[] NOT NULL DEFAULT '{}' CHECK (cardinality(email_domains) <= 10),
  enabled                  boolean NOT NULL DEFAULT false,
  button_label             text CHECK (button_label IS NULL OR char_length(button_label) BETWEEN 1 AND 30),
  updated_by               uuid REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  -- 켜진 설정은 비밀값이 있어야 한다
  CONSTRAINT org_sso_providers_enabled_secret_check CHECK (NOT enabled OR client_secret_encrypted IS NOT NULL)
);

ALTER TABLE public.org_sso_providers ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON public.org_sso_providers FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON public.org_sso_providers FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.org_sso_providers TO service_role';
  END IF;
END $$;
