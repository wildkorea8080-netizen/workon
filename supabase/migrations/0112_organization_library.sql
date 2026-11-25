-- 0112: 기관 자료함 (2026-11-25)
--
-- 내 자료함(0103)·부서 자료함(0106)과 같은 표에 자리 organization(기관 전체 직원이 함께 보는 자료함)을 더한다.
-- - 기관 자료함 행은 department_id가 없다(기관 단위). 보기·다시 붙이기·내려받기는 **같은 기관 직원 누구나**,
--   담기·이름/폴더 바꾸기·지우기는 **기관 전체 관리자만**(코드가 본다 — 기관 전체에 보이는 자료이므로).
-- - 담은 관리자가 탈퇴해도 남는다(탈퇴 처리는 내 자료함만 지운다).
-- 값만 넓힘(옛 CHECK를 지우고 다시 검), 여러 번 적용해도 안전. **0106 뒤·코드 배포 전에 적용** — 없으면 기관 자료함에 담기가 CHECK에 걸려 실패한다
-- (목록은 빈 목록으로 돈다).

ALTER TABLE public.my_library_files DROP CONSTRAINT IF EXISTS my_library_files_space_check;
ALTER TABLE public.my_library_files ADD CONSTRAINT my_library_files_space_check CHECK (
  (space = 'personal' AND department_id IS NULL)
  OR (space = 'department' AND department_id IS NOT NULL)
  OR (space = 'organization' AND department_id IS NULL)
);

CREATE INDEX IF NOT EXISTS my_library_files_organization_idx
  ON public.my_library_files (organization_id, created_at DESC, id DESC) WHERE space = 'organization';
