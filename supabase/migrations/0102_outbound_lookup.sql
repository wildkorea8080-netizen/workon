-- 0102: 앱 결과 보낼 곳(0076)을 입력형 앱의 '기관 연동 시스템 조회' 단계에도 쓰기(2026-11-24)
--
-- 기관 전체 관리자가 보낼 곳마다 '앱 조회에도 쓰기'를 켜면, 입력형 앱의 조회 단계가 그 주소에 조회어를 서명해 보내고(POST, 8초)
-- 받은 답을 다음 단계의 자료로 쓴다(src/lib/apps/outbound/lookup.ts). 결과를 받기만 하라고 승인한 주소가 조회 대상까지 되지 않도록
-- 기본은 꺼짐이다. 추가만·여러 번 적용해도 안전. **코드 배포 전에 적용** — 새 코드가 이 칸을 읽어, 없으면 보낼 곳 화면·조회 단계가 실패한다.
ALTER TABLE public.app_outbound_endpoints ADD COLUMN IF NOT EXISTS lookup_enabled boolean NOT NULL DEFAULT false;
