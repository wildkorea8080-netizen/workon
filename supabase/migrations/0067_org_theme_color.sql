-- =============================================================
-- 0067_org_theme_color.sql
-- 기관 테마 색 — 업무 화면의 강조 색(단추·선택된 메뉴·테두리)을 기관이 고른다
--
-- 배경:
--   기관 이름·로고는 0020부터 기관마다 달랐지만 색은 청록 하나로 고정이었다.
--   공공기관은 CI 색이 정해진 곳이 많고, 알리웍스도 관리자가 테마 색을 고른다.
--   색 하나만 저장하고 단추 글·연한 바탕·테두리 색은 코드(src/lib/theme-color.ts)가 만든다.
--
-- NULL = 기본 청록(지금 화면 그대로). 값은 '#rrggbb' 소문자만.
-- 흰 글이 읽히는지(대비 4.5:1)는 저장하는 라우트가 본다 — DB는 꼴만 막는다.
--
-- 추가만. 여러 번 적용해도 안전.
-- **코드 배포 전에 적용** — 새 코드의 기관 정보 화면·저장이 이 칸을 읽고 쓴다
-- (화면 머리·로그인의 브랜딩 응답은 칸이 없어도 기본 색으로 돈다).
-- =============================================================

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS theme_color text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_theme_color_check'
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_theme_color_check
      CHECK (theme_color IS NULL OR theme_color ~ '^#[0-9a-f]{6}$');
  END IF;
END $$;

COMMENT ON COLUMN organizations.theme_color IS
  '업무 화면 강조 색(#rrggbb 소문자). NULL이면 기본 청록. 흰 글 대비 4.5:1 이상만 저장(라우트가 검사).';
