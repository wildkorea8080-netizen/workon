-- 0094: 직원 접속 기록 (2026-11-16)
--
-- 직원 로그인은 성공·실패 모두 어디에도 남지 않았다(슈퍼관리자 로그인만 access_logs에 남았다). 공공기관은 접속 기록을 남기고
-- 정기 점검해야 한다. 직원 로그인 성공·실패·잠김·거절을 access_logs에 남기고(src/lib/sign-in-record.ts), 기관 관리자가 감사 화면의
-- '접속 기록'에서 관리 범위 직원 것만 본다 — 그러려면 행에 부서가 있어야 해 department_id를 더한다. 마지막 로그인 때는 users에 둔다.
-- 추가만, 여러 번 적용해도 안전. access_logs·users는 0090으로 이미 RLS가 켜져 있다.
-- 코드 배포 전에 적용 — 새 코드가 두 칸에 쓰고 읽어, 없으면 기록·감사 '접속 기록'·사용자 목록이 실패한다(로그인 자체는 된다).

ALTER TABLE public.access_logs ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS access_logs_department_created_idx ON public.access_logs (department_id, created_at DESC) WHERE department_id IS NOT NULL;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_sign_in_at timestamptz;
