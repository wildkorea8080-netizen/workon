-- 0110: 기관 SSO 그룹 → 부서 맞추기(2026-11-25)
--
-- 기관 전체 관리자가 SSO 설정에 '부서를 정할 클레임'(예: groups·department)과 '값 → WORKON 부서' 목록(100개까지)을 적으면,
-- 기관 계정(SSO)으로 로그인할 때 id_token의 그 클레임 값 중 목록에서 처음 맞는 부서로 **일반 직원(USER)**의 소속을 옮긴다
-- (src/lib/org-sso.ts `groupDepartment`·`syncDepartment`). 인사 이동을 계정 서비스에서 한 번만 고치면 된다.
-- - 관리자(ADMIN)의 소속은 옮기지 않는다 — 소속이 관리 범위를 정하므로 계정 서비스 설정 하나로 관리 범위가 바뀌지 않게.
-- - 계정을 만들지 않고, 역할도 바꾸지 않는다. 맞는 값이 없으면 소속은 그대로 둔다(로그인은 막지 않음).
-- - 부서는 이 기관 부서만(저장할 때와 로그인할 때 다시 본다). 옮기면 보안 로그 `user_department_synced`.
-- 추가만, 여러 번 적용해도 안전. **0109 뒤·코드 배포 전에 적용** — 새 코드가 SSO 설정에서 이 칸들을 select 해, 없으면 SSO 설정 화면·기관 계정 로그인이 실패한다.
ALTER TABLE public.org_sso_providers ADD COLUMN IF NOT EXISTS group_claim text;
ALTER TABLE public.org_sso_providers ADD COLUMN IF NOT EXISTS group_mappings jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_sso_providers_group_claim_check') THEN
    ALTER TABLE public.org_sso_providers ADD CONSTRAINT org_sso_providers_group_claim_check
      CHECK (group_claim IS NULL OR char_length(group_claim) BETWEEN 1 AND 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_sso_providers_group_mappings_check') THEN
    -- 배열·100개까지, 목록이 있으면 클레임도 있어야 한다
    ALTER TABLE public.org_sso_providers ADD CONSTRAINT org_sso_providers_group_mappings_check
      CHECK (jsonb_typeof(group_mappings) = 'array' AND jsonb_array_length(group_mappings) <= 100
             AND (jsonb_array_length(group_mappings) = 0 OR group_claim IS NOT NULL));
  END IF;
END $$;
