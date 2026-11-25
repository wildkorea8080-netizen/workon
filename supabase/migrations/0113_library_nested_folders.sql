-- 0113: 자료함 여러 단계 폴더 (2026-11-25)
--
-- 내 자료함·부서 자료함·기관 자료함(0103·0106·0112)의 폴더를 `예산/2026/서식`처럼 `/`로 나눈 3단계까지 둔다(src/lib/my-library-spec.ts
-- `cleanFolderName` — 한 단계 30자). 폴더를 고르면 그 아래 폴더의 파일도 함께 보인다. 폴더 칸 길이 CHECK를 30자에서 100자로 넓힌다.
-- 값만 넓힘(옛 CHECK를 찾아 지우고 다시 검), 여러 번 적용해도 안전. **코드 배포 전에 적용** — 없으면 두 단계 이상 폴더에 담기·옮기기가 CHECK에 걸려 실패한다
-- (한 단계 폴더는 그대로 돈다).
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.my_library_files'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%folder%'
  LOOP
    EXECUTE format('ALTER TABLE public.my_library_files DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.my_library_files ADD CONSTRAINT my_library_files_folder_check CHECK (char_length(folder) <= 100);
