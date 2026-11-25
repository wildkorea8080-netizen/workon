-- 0115: 기관 SSO 그룹 → 관리자 역할(2026-11-25)
--
-- 기관 전체 관리자가 SSO 설정에 '관리자로 들일 그룹 값'(20개까지 — 그룹 → 부서와 같은 클레임 `group_claim`)을 적으면,
-- 기관 계정(SSO)으로 로그인할 때 id_token의 그 클레임에 그 값이 있는 **일반 직원**을 관리자(ADMIN)로 올린다
-- (src/lib/org-sso.ts `adminGroupMatch`·`syncRole`). 계정 서비스의 관리자 그룹을 한 번만 고치면 된다.
-- - 이 길로 올린 관리자만 `users.role_from_sso`가 참이고, 그 사람이 그룹에서 빠진 채 기관 계정으로 다시 로그인하면 일반 직원으로 내린다.
--   기관 관리자가 손으로 지정한 관리자(참이 아님)는 그룹과 상관없이 건드리지 않는다. 관리자가 손으로 권한을 바꾸면 이 표시를 지운다.
-- - 목록을 비우면 아무도 올리거나 내리지 않는다(이미 올린 관리자는 그대로 — 사람이 정리).
-- - 슈퍼관리자·탈퇴·사용 중지 계정은 대상이 아니고, 소속(관리 범위)은 바꾸지 않는다. 올리고 내릴 때 보안 로그 `user_role_synced`(high).
-- 추가만, 여러 번 적용해도 안전. **0114 뒤·코드 배포 전에 반드시 적용** — 새 코드가 SSO 설정·직원 찾기에서 이 칸들을 select 해,
-- 없으면 기관 계정 로그인·SSO 설정 화면이 실패한다.
ALTER TABLE public.org_sso_providers ADD COLUMN IF NOT EXISTS admin_groups text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS role_from_sso boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_sso_providers_admin_groups_check') THEN
    -- 20개까지, 목록이 있으면 클레임도 있어야 한다
    ALTER TABLE public.org_sso_providers ADD CONSTRAINT org_sso_providers_admin_groups_check
      CHECK (cardinality(admin_groups) <= 20 AND (cardinality(admin_groups) = 0 OR group_claim IS NOT NULL));
  END IF;
END $$;
