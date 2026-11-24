-- 0106: 부서 자료함 (2026-11-24)
--
-- 내 자료함(0103)과 같은 표에 자리(space)를 더한다 — personal(담은 사람만) · department(그 부서 사람이 함께).
-- 부서 자료함 행은 department_id(담을 때 담은 사람의 부서)가 있고, 내 자료함 행은 없다(CHECK로 짝).
-- - 보기·다시 붙이기·내려받기는 요청자의 **지금 부서**의 행만, 이름·폴더 바꾸기·지우기는 담은 사람이나 관리자만(코드가 본다).
-- - 담은 사람이 탈퇴하거나 부서를 옮겨도 부서 자료함 파일은 그 부서에 남는다(탈퇴 처리는 내 자료함만 지운다).
-- - 부서 외래 키는 지우기를 막는다(NO ACTION) — 부서 삭제 판정(department-delete.ts)이 '부서 자료함' 기록으로 먼저 막는다.
-- 추가만(기존 행은 personal), 여러 번 적용해도 안전. **0103 뒤·코드 배포 전에 적용** — 새 코드가 space 칸으로 조회해, 없으면 자료함 화면이 실패한다.

ALTER TABLE public.my_library_files ADD COLUMN IF NOT EXISTS space text NOT NULL DEFAULT 'personal';
ALTER TABLE public.my_library_files ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES public.departments(id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'my_library_files_space_check') THEN
    ALTER TABLE public.my_library_files ADD CONSTRAINT my_library_files_space_check CHECK (
      (space = 'personal' AND department_id IS NULL) OR (space = 'department' AND department_id IS NOT NULL)
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS my_library_files_department_idx
  ON public.my_library_files (department_id, created_at DESC, id DESC) WHERE space = 'department';
