-- 0095: 장기 미접속 계정 잠금 — 기관이 켤 때만 (2026-11-16)
--
-- 공공기관 보안 점검의 흔한 항목(오래 접속하지 않은 계정 잠금). 실제 직원을 잠그므로 기본은 꺼짐이고, 기관 전체 관리자가
-- 기간(30~365일)을 정해 켠다(src/lib/dormant-lock.ts). 잠기면 계정이 '사용 중지'가 되고 관리자가 '다시 사용'으로 푼다.
-- - organizations.dormant_lock_days: 켜면 기간, 꺼짐이면 NULL
-- - organizations.dormant_lock_since: 켠 때 — 이보다 앞의 미접속은 세지 않는다(로그인 기록이 2026-11-16부터라
--   켜는 순간 모두 잠기지 않게)
-- - users.reactivated_at: 관리자가 다시 사용하게 한 때 — 풀자마자 다시 잠기지 않게 이때부터 센다
-- 추가만, 여러 번 적용해도 안전. organizations·users는 0090으로 이미 RLS가 켜져 있다.
-- 코드 배포 전에 적용 — 새 로그인이 이 칸들을 읽어, 없으면 잠금 확인을 못 해 열림(잠그지 않음)으로 돈다.

ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS dormant_lock_days smallint;
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS dormant_lock_since timestamptz;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_dormant_lock_days_check') THEN
    ALTER TABLE public.organizations ADD CONSTRAINT organizations_dormant_lock_days_check
      CHECK (dormant_lock_days IS NULL OR (dormant_lock_days BETWEEN 30 AND 365 AND dormant_lock_since IS NOT NULL));
  END IF;
END $$;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS reactivated_at timestamptz;
