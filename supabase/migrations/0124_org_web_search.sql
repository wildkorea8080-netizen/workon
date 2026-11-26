-- 0124: 기관 웹 검색 스위치(2026-11-26) — src/lib/web-search-switch.ts, src/lib/capabilities/web-search.ts, docs/benchmarks/allganize/WEB_SEARCH.md
-- 비서의 '웹 검색' 능력은 Anthropic 서버 도구(web_search)라 검색어가 기관 밖(Anthropic의 검색 제공자)으로 간다 — 그래서 기본은 꺼짐이고,
-- 기관 전체 관리자가 사유와 함께 켤 때만 돈다(보안 로그 high). 켠 때·사유를 남긴다(둘은 짝).
-- 추가만(칸 둘·CHECK). 여러 번 적용해도 안전. 코드 배포 전에 적용 — 없으면 웹 검색 설정 화면만 실패하고, 대화는 웹 검색 없이 돈다(못 읽으면 꺼짐).

ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS web_search_enabled_at timestamptz;
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS web_search_enabled_reason text;

ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_web_search_pair_check;
ALTER TABLE public.organizations ADD CONSTRAINT organizations_web_search_pair_check
  CHECK ((web_search_enabled_at IS NULL) = (web_search_enabled_reason IS NULL));

ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_web_search_reason_check;
ALTER TABLE public.organizations ADD CONSTRAINT organizations_web_search_reason_check
  CHECK (web_search_enabled_reason IS NULL OR char_length(web_search_enabled_reason) BETWEEN 1 AND 300);

NOTIFY pgrst, 'reload schema';
