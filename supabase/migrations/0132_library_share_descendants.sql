-- 0132: 공유 자료함(0116)에 '하위 부서도 함께' (src/lib/library-shares.ts · my-library.ts `loadLibraryShares`)
--
-- 공유 자료함은 고른 부서에 지금 소속된 직원만 열었다 — 본부를 골라도 그 아래 과·팀 직원은 못 보아, 조직도의 과마다 따로 골라야 했고
-- 과를 새로 만들면 다시 넣어야 했다. 켜 두면 고른 부서와 그 하위 부서(몇 단계든) 직원이 함께 쓴다(부서 비서를 하위 부서가 쓰는 것과 같은 방향 —
-- 상위 부서는 아님). 기본은 꺼짐(지금 공유 자료함은 그대로).
-- 추가만, 여러 번 적용해도 안전. 코드 배포 전에 적용 — 새 코드가 모든 자료함 요청에서 공유 자료함을 읽을 때 이 칸을 select 해, 없으면 자료함 화면이 실패한다.
ALTER TABLE public.library_shares ADD COLUMN IF NOT EXISTS include_descendants boolean NOT NULL DEFAULT false;
NOTIFY pgrst, 'reload schema';
