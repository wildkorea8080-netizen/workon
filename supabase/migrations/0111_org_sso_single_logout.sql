-- 0111: 기관 SSO 함께 로그아웃(2026-11-25)
--
-- 기관 전체 관리자가 SSO 설정에서 '로그아웃할 때 계정 서비스에서도 로그아웃'을 켜면, 기관 계정(SSO)으로 들어온 직원이 WORKON에서
-- 로그아웃할 때 계정 서비스의 로그아웃 주소(발견 문서의 end_session_endpoint — OIDC RP-Initiated Logout)로 보내 그쪽 로그인도 끝낸다
-- (POST /api/sso/logout, src/lib/org-sso.ts `ssoLogoutUrl`). 공용 PC에서 다음 사람이 기관 계정 단추로 앞사람 계정에 그대로 들어가지 않게.
-- 기본은 꺼짐 — Microsoft Entra ID는 그 브라우저의 Microsoft 365 로그인까지 끝내므로 기관이 고른다. 켜진 SSO에만 걸 수 있다.
-- 추가만, 여러 번 적용해도 안전. **0110 뒤·코드 배포 전에 적용** — 새 코드가 SSO 설정에서 이 칸을 select 해, 없으면 기관 계정 로그인·SSO 설정 화면이 실패한다.
ALTER TABLE public.org_sso_providers ADD COLUMN IF NOT EXISTS single_logout boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_sso_providers_single_logout_check') THEN
    ALTER TABLE public.org_sso_providers ADD CONSTRAINT org_sso_providers_single_logout_check CHECK (NOT single_logout OR enabled);
  END IF;
END $$;
