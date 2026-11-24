-- 0109: 기관 SSO 전용 — 직원 비밀번호 로그인 끄기(2026-11-25)
--
-- 기관 SSO(0107)를 켠 기관이 '직원은 기관 계정으로만 로그인'을 고르면 직원(USER) 계정의 이메일·비밀번호 로그인을 막는다
-- (src/lib/sso-only.ts — 비밀번호가 맞아도 SSO_ONLY로 거절). 이미 비밀번호로 들어와 있던 직원의 로그인은 미들웨어가 30초 안에 끝낸다.
-- 기관 관리자(ADMIN)는 비밀번호 로그인을 그대로 쓴다 — 계정 서비스가 고장 나거나 설정이 틀려도 기관이 잠기지 않게(설정을 고칠 사람이 남게).
-- 켜진 SSO에만 걸 수 있다(CHECK). 추가만, 여러 번 적용해도 안전. **코드 배포 전에 적용** — 새 코드가 이 칸을 읽고 써서,
-- 없으면 SSO 설정 화면·저장·기관 로그인 화면의 SSO 단추가 실패한다(비밀번호 로그인은 그대로).
ALTER TABLE public.org_sso_providers ADD COLUMN IF NOT EXISTS sso_only boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_sso_providers_sso_only_check' AND conrelid = 'public.org_sso_providers'::regclass) THEN
    ALTER TABLE public.org_sso_providers ADD CONSTRAINT org_sso_providers_sso_only_check CHECK (NOT sso_only OR enabled);
  END IF;
END $$;
