-- 0116: 공유 자료함 — 여러 부서만 골라 함께 쓰는 자료함 (2026-11-25)
--
-- 내 자료함(0103)·부서 자료함(0106)·기관 자료함(0112)에 이어, 기관 전체 관리자가 이름과 부서 목록(1~50곳)을 정해 만드는 '공유 자료함'.
-- - library_shares: 기관마다 50개까지(코드가 센다), 이름은 기관 안에서 하나(대소문자 무시).
-- - library_share_departments: 공유 자료함 ↔ 부서. 부서를 지우면 그 부서 줄만 빠진다(자료함·파일은 남음).
-- - my_library_files.space에 'shared' + share_id(공유 자료함 — 파일이 남아 있으면 자료함을 지우지 못함). 'shared' 행만 share_id가 있다.
-- - 보기·담기·다시 붙이기는 **지금 소속 부서가 그 목록에 든 직원**(하위·상위 부서는 따로), 이름/폴더 바꾸기·지우기는 담은 사람이나 관리자 —
--   코드가 본다(src/lib/my-library.ts `placeActor`·`canChangeLibraryRow`).
-- 추가만(space CHECK는 값만 넓힘), 여러 번 적용해도 안전, 새 표 RLS 켜고 정책 없음·공개 키 권한 없음.
-- **0115 뒤·코드 배포 전에 반드시 적용** — 새 코드가 모든 자료함 요청에서 공유 자료함 목록(library_share_departments)을 읽어, 없으면 자료함 화면이 실패한다.

CREATE TABLE IF NOT EXISTS public.library_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS library_shares_org_name_idx ON public.library_shares (organization_id, lower(name));

CREATE TABLE IF NOT EXISTS public.library_share_departments (
  share_id uuid NOT NULL REFERENCES public.library_shares(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
  PRIMARY KEY (share_id, department_id)
);
CREATE INDEX IF NOT EXISTS library_share_departments_department_idx ON public.library_share_departments (department_id);

ALTER TABLE public.library_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.library_share_departments ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.library_shares, public.library_share_departments FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.library_shares, public.library_share_departments FROM authenticated;
  END IF;
END $$;

ALTER TABLE public.my_library_files ADD COLUMN IF NOT EXISTS share_id uuid REFERENCES public.library_shares(id) ON DELETE RESTRICT;

ALTER TABLE public.my_library_files DROP CONSTRAINT IF EXISTS my_library_files_space_check;
ALTER TABLE public.my_library_files ADD CONSTRAINT my_library_files_space_check CHECK (
  (space = 'personal' AND department_id IS NULL AND share_id IS NULL)
  OR (space = 'department' AND department_id IS NOT NULL AND share_id IS NULL)
  OR (space = 'organization' AND department_id IS NULL AND share_id IS NULL)
  OR (space = 'shared' AND department_id IS NULL AND share_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS my_library_files_share_idx
  ON public.my_library_files (share_id, created_at DESC, id DESC) WHERE space = 'shared';
