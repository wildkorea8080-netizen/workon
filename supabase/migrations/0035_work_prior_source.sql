-- =============================================================
-- 0035_work_prior_source.sql
-- 원자료 용도 'prior'(작년 파일) — 현행화 업무(S6-1)가 작년 문서를 올릴 때 붙이는 용도
--
-- 0034가 work_sources.purpose에 걸어 둔 CHECK(work_sources_purpose_check)에 'prior'를 더한다.
-- 값만 넓히는 변경이라 기존 행은 그대로 통과한다. 여러 번 적용해도 안전하다(이름으로 지우고 다시 건다).
-- 배포 순서: 이 파일 → 현행화 코드 푸시(코드가 purpose='prior'로 올린다). 사용자가 직접 적용한다.
-- =============================================================

ALTER TABLE work_sources DROP CONSTRAINT IF EXISTS work_sources_purpose_check;
ALTER TABLE work_sources
  ADD CONSTRAINT work_sources_purpose_check
  CHECK (purpose IN ('reference','data','request','template','evidence','prior'));
