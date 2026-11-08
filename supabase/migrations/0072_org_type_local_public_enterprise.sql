-- =============================================================
-- 0072_org_type_local_public_enterprise.sql
-- 기관 유형에 '지방공기업' 추가 — 공통 자료실(0033)의 유형 CHECK를 넓힌다
--
-- 배경:
--   지방공기업법을 따르는 공사·공단(도시공사·시설관리공단 등)은 예산편성기준·회계기준·경영평가 편람이
--   공공기관(공공기관의 운영에 관한 법률)과 다르다. 그런데 유형이 '공공기관' 하나뿐이라 두 쪽의 정부 기준 문서가
--   같은 공통 보관함에 섞여, 지방공기업 비서가 공공기관 기준을 근거로 답할 수 있었다(S5 알려진 한계).
--
-- 바꾸는 것:
--   common_documents.org_type CHECK에 '지방공기업'을 더한다(값만 넓힘). organizations.type은 CHECK가 없는 글 칸이라 그대로다.
--   공통 보관함 이름은 workon-c-lpe(코드 `ORG_TYPE_KEYS`).
--   기존 기관의 유형은 바꾸지 않는다 — 지방공기업인 기관은 슈퍼관리자가 기관 화면에서 유형을 고친다(그 다음 질문부터 새 공통 자료실).
--
-- 여러 번 적용해도 안전.
-- **코드 배포 전에 적용** — 새 코드로 '지방공기업' 공통 문서를 올리면 이 CHECK가 있어야 저장된다(없으면 그 올리기만 실패).
-- =============================================================

ALTER TABLE common_documents DROP CONSTRAINT IF EXISTS common_documents_org_type_check;
ALTER TABLE common_documents ADD CONSTRAINT common_documents_org_type_check
  CHECK (org_type IN ('중앙행정기관','지방자치단체','공공기관','지방공기업','교육기관','협회단체','일반기업'));
