-- =============================================================
-- 0020_org_branding.sql
-- 기관 브랜딩 — 로그인 경로 slug + AI 고지 문구
--
-- 배경:
--   멀티테넌트 제품인데 화면에 보이는 이름이 NEXT_PUBLIC_APP_NAME 전역
--   단일값이었다. 공공기관은 CI 사용이 규정 사항이라 "우리 기관 시스템"으로
--   보이지 않으면 도입 자체가 어색해진다.
--
--   logo_url 컬럼은 0006에 이미 있었으나 쓰는 곳이 없었다. 0020은 그것을
--   실제로 쓰기 위한 나머지 조각을 채운다.
-- =============================================================

-- ── 1. 로그인 경로 slug ──────────────────────────────────────
-- /signin/{slug} 로 기관 전용 로그인 화면을 연다. 웍스AI가 senGPT를
-- gov.wrks.ai로 분리해 "전용 시스템"으로 보이게 한 것과 같은 효과를
-- 도메인 분리 없이 낸다.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS slug text;

COMMENT ON COLUMN organizations.slug IS
  '기관 전용 로그인 경로(/signin/{slug})에 쓰는 식별자. 영문 소문자·숫자·하이픈.';


-- ── 2. AI 고지 문구 ──────────────────────────────────────────
-- 생성 결과를 그대로 믿으면 안 된다는 안내. senGPT도 명시하고 있고,
-- 공공기관 배포에서는 사실상 필수다. 기관마다 표현이 다를 수 있어
-- 컬럼으로 두되, 비어 있으면 코드의 기본 문구를 쓴다.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS ai_notice text;

COMMENT ON COLUMN organizations.ai_notice IS
  'AI 생성 결과에 대한 기관 고지 문구. NULL이면 기본 문구를 쓴다.';


-- ── 3. 기존 기관 slug 백필 ───────────────────────────────────
-- 이름에서 만든다. 한글은 slug로 쓸 수 없으므로 영문·숫자만 남기고,
-- 남는 게 없으면 org-{id 앞 8자}로 둔다. 관리자가 나중에 바꿀 수 있다.
DO $$
DECLARE
  r        record;
  v_base   text;
  v_slug   text;
  v_suffix integer;
BEGIN
  FOR r IN SELECT id, name FROM organizations WHERE slug IS NULL LOOP
    v_base := lower(regexp_replace(coalesce(r.name, ''), '[^a-zA-Z0-9]+', '-', 'g'));
    v_base := trim(both '-' from v_base);

    IF v_base = '' THEN
      v_base := 'org-' || substr(r.id::text, 1, 8);
    END IF;

    v_slug := v_base;
    v_suffix := 1;

    -- 같은 이름의 기관이 있으면 뒤에 번호를 붙인다
    WHILE EXISTS (SELECT 1 FROM organizations WHERE slug = v_slug) LOOP
      v_suffix := v_suffix + 1;
      v_slug := v_base || '-' || v_suffix;
    END LOOP;

    UPDATE organizations SET slug = v_slug WHERE id = r.id;
  END LOOP;
END $$;


-- ── 4. 유일성 ────────────────────────────────────────────────
-- 중복되면 /signin/{slug}가 어느 기관인지 정할 수 없다.
CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_idx
  ON organizations(slug)
  WHERE slug IS NOT NULL;


-- ── 확인 ─────────────────────────────────────────────────────
SELECT
  name          AS 기관,
  slug          AS 로그인경로,
  CASE WHEN logo_url IS NULL THEN '없음' ELSE '있음' END AS 로고,
  CASE WHEN ai_notice IS NULL THEN '기본 문구' ELSE '기관 지정' END AS 고지문구
FROM organizations
ORDER BY created_at;
