-- 0103: 내 자료함 (2026-11-24)
--
-- 직원이 자주 쓰는 파일(대화에 올린 파일·비서가 만들어 준 파일)을 **사본**으로 담아 폴더로 나눠 두고,
-- 대화·입력형 앱의 '지난 파일'에서 새 첨부로 다시 붙인다(src/lib/my-library.ts). 대화를 지워도 남는다.
-- - 주인만(user_id = 요청자 — 관리자도 남의 자료함은 못 본다), 다시 붙이기·내려받기 때마다 서버가 주인·기관을 다시 본다.
-- - 저장소 경로는 서버가 정한다: my-library/{기관}/{직원}/{id}.{확장자}. 화면에는 경로를 내보내지 않는다.
-- - 폴더는 한 단계(이름 글, '' = 미분류). 한 사람 300개·폴더 30개는 코드가 본다.
-- - 부서 칸이 없다(개인 자료라 부서 삭제 판정 대상이 아니다). 탈퇴 처리가 행과 사본을 지운다.
-- 추가만, 여러 번 적용해도 안전, RLS 켜고 정책 없음·공개 키 권한 없음(서비스 키만).
-- 코드 배포 전에 적용 — 없으면 내 자료함 화면·담기만 실패한다(대화·지난 파일은 그대로).

CREATE TABLE IF NOT EXISTS public.my_library_files (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  folder          text NOT NULL DEFAULT '' CHECK (char_length(folder) <= 30),
  file_name       text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  size_bytes      bigint NOT NULL CHECK (size_bytes > 0),
  storage_path    text NOT NULL UNIQUE CHECK (storage_path LIKE 'my-library/%'),
  source          text NOT NULL CHECK (source IN ('attachment', 'generated')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS my_library_files_user_idx ON public.my_library_files (user_id, created_at DESC, id DESC);

ALTER TABLE public.my_library_files ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON public.my_library_files FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON public.my_library_files FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.my_library_files TO service_role';
  END IF;
END $$;
