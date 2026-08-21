-- 0023: 기관별 접속 IP 제한
--
-- 공공기관은 근무지 외 사용 통제가 복무 규정 사항이다. "기관이 비용을 내는
-- 도구를 청사 밖에서 개인 용도로 쓰지 않는다"를 시스템으로 보이려면 정책
-- 문서가 아니라 실제 차단이 필요하다.
--
-- 왜 기관 단위인가:
--   슈퍼관리자 설정에 시스템 전역 'allowed_ips'가 있었지만 **읽는 코드가
--   없었다.** 설정한 사람은 막았다고 믿는데 아무 일도 일어나지 않았다.
--   게다가 전역 하나로는 멀티테넌트에서 쓸 수 없다 — 기관마다 청사 대역이
--   다르기 때문이다.
--
-- NULL 과 빈 배열의 뜻:
--   둘 다 "제한 없음"이다. 이 기능을 켠 적 없는 기관을 잠그면 안 된다.
--   0021의 allowed_models가 빈 배열을 저장하지 않는 것과 같은 이유로,
--   화면에서도 빈 값은 NULL로 되돌린다.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS allowed_ips text[];

COMMENT ON COLUMN organizations.allowed_ips IS
  '접속 허용 IP/CIDR 목록. NULL 또는 빈 배열이면 제한 없음. 판정은 src/lib/ip-access.ts';

-- 미들웨어가 30초마다 "제한을 켠 기관이 있는가"만 먼저 확인한다.
-- 아무도 안 쓰면 여기서 끝나고 부서 조회로 내려가지 않는다.
CREATE INDEX IF NOT EXISTS idx_organizations_allowed_ips
  ON organizations (id)
  WHERE allowed_ips IS NOT NULL;
