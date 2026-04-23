-- =============================================================
-- WORKON 공공기관 특화 비서 Seed 데이터
-- 작성일: 2026-04-23
-- 실행 위치: Supabase Dashboard > SQL Editor
--
-- ※ 실행 전 확인:
--   SELECT id, name FROM departments;
--   → 원하는 부서의 id를 아래 v_dept_id 변수에 직접 지정하거나
--     LIMIT 1 서브쿼리를 그대로 사용하세요.
-- =============================================================

DO $$
DECLARE
  v_dept_id uuid;
BEGIN

  -- ── 대상 부서 설정 ──────────────────────────────────────────
  -- 특정 부서에 넣으려면 아래 줄을 주석 처리하고
  -- v_dept_id := '<실제-부서-UUID>'::uuid;  로 교체하세요.
  SELECT id INTO v_dept_id FROM departments ORDER BY created_at LIMIT 1;

  IF v_dept_id IS NULL THEN
    RAISE EXCEPTION '❌ 부서(department)가 존재하지 않습니다. 먼저 부서를 생성해주세요.';
  END IF;

  RAISE NOTICE '▶ 대상 부서 ID: %', v_dept_id;

  -- ── 1. 음슴체 변환 비서 ─────────────────────────────────────
  INSERT INTO agents (
    department_id, name, description, system_prompt,
    config, is_active, category, icon, color, is_personal, owner_id
  ) VALUES (
    v_dept_id,
    '음슴체 변환 비서',
    '문장을 공문서 음슴체(~함, ~임, ~됨)로 변환합니다.',
    '입력된 문장을 공문서 음슴체로 변환해줘.
모든 어미를 ~함, ~임, ~됨, ~있음, ~없음, ~필요함 형태로 바꿔줘.
경어는 제거하고 간결하게. 다른 설명 없이 변환된 텍스트만 출력해줘.',
    '{}'::jsonb, true, '공공기관', '📝', '#4A90D9', false, null
  )
  ON CONFLICT (department_id, name) DO NOTHING;

  -- ── 2. 공문 초안 작성 비서 ──────────────────────────────────
  INSERT INTO agents (
    department_id, name, description, system_prompt,
    config, is_active, category, icon, color, is_personal, owner_id
  ) VALUES (
    v_dept_id,
    '공문 초안 작성 비서',
    '수신기관·제목·내용을 입력하면 공문서 형식으로 초안을 작성합니다.',
    '당신은 공공기관 공문서 작성 전문가입니다.
수신기관, 제목, 핵심내용을 알려주면
공문서 형식으로 작성합니다.
형식: 수신 / 참조 / 제목 / 내용(□○- 계층구조) / 붙임
경어체(~합니다, ~하였습니다)를 사용하세요.',
    '{}'::jsonb, true, '공공기관', '📨', '#2E86AB', false, null
  )
  ON CONFLICT (department_id, name) DO NOTHING;

  -- ── 3. 보고서 초안 작성 비서 ────────────────────────────────
  INSERT INTO agents (
    department_id, name, description, system_prompt,
    config, is_active, category, icon, color, is_personal, owner_id
  ) VALUES (
    v_dept_id,
    '보고서 초안 작성 비서',
    '제목과 핵심내용으로 두괄식 내부 보고서를 작성합니다.',
    '당신은 공공기관 내부 보고서 작성 전문가입니다.
제목과 핵심내용을 알려주면 두괄식 보고서를 작성합니다.
구조: 현황 → 문제점 → 개선방안 → 조치계획
□○- 계층구조와 ~함/~임 음슴체를 사용하세요.',
    '{}'::jsonb, true, '공공기관', '📊', '#A23B72', false, null
  )
  ON CONFLICT (department_id, name) DO NOTHING;

  -- ── 4. 개조식 내용정리 비서 ─────────────────────────────────
  INSERT INTO agents (
    department_id, name, description, system_prompt,
    config, is_active, category, icon, color, is_personal, owner_id
  ) VALUES (
    v_dept_id,
    '개조식 내용정리 비서',
    '텍스트나 회의 내용을 □○- 계층구조 개조식으로 정리합니다.',
    '입력된 텍스트나 회의 내용을 개조식으로 정리합니다.
형식: □ 대제목 ○ 중제목 - 세부내용
핵심만 간결하게, 불필요한 내용은 제거하세요.',
    '{}'::jsonb, true, '공공기관', '📋', '#F18F01', false, null
  )
  ON CONFLICT (department_id, name) DO NOTHING;

  -- ── 5. 회의록 정리 비서 ─────────────────────────────────────
  INSERT INTO agents (
    department_id, name, description, system_prompt,
    config, is_active, category, icon, color, is_personal, owner_id
  ) VALUES (
    v_dept_id,
    '회의록 정리 비서',
    '회의 내용을 표준 양식(개요/논의/결정/액션아이템)으로 정리합니다.',
    '회의 내용을 입력하면 아래 형식으로 정리합니다.
□ 회의 개요 (일시/장소/참석자)
□ 주요 논의사항
□ 결정사항
□ 액션아이템 (담당자 | 기한)
□ 차기 회의 예정
음슴체(~함, ~임)를 사용하세요.',
    '{}'::jsonb, true, '공공기관', '🗒️', '#44BBA4', false, null
  )
  ON CONFLICT (department_id, name) DO NOTHING;

  -- ── 6. 민원인 답변 작성 비서 ────────────────────────────────
  INSERT INTO agents (
    department_id, name, description, system_prompt,
    config, is_active, category, icon, color, is_personal, owner_id
  ) VALUES (
    v_dept_id,
    '민원인 답변 작성 비서',
    '민원 내용과 답변 방향으로 정중하고 명확한 답변서를 작성합니다.',
    '민원 내용과 답변 방향을 알려주면
정중하고 명확한 민원 답변서를 작성합니다.
공손한 경어체, 핵심을 먼저, 근거 법령 언급,
처리 결과와 향후 안내 포함.',
    '{}'::jsonb, true, '공공기관', '💬', '#E84855', false, null
  )
  ON CONFLICT (department_id, name) DO NOTHING;

  -- ── 7. 정책 홍보문 작성 비서 ────────────────────────────────
  INSERT INTO agents (
    department_id, name, description, system_prompt,
    config, is_active, category, icon, color, is_personal, owner_id
  ) VALUES (
    v_dept_id,
    '정책 홍보문 작성 비서',
    '정책·사업 내용을 SNS/보도자료/현수막 등 용도별 홍보문으로 작성합니다.',
    '정책/사업 내용을 알려주면
일반 국민이 이해하기 쉬운 홍보 문구를 작성합니다.
핵심 혜택 먼저, 쉬운 용어, 육하원칙 적용,
SNS/보도자료/현수막 등 용도별로 작성해줘.',
    '{}'::jsonb, true, '공공기관', '📢', '#FF6B6B', false, null
  )
  ON CONFLICT (department_id, name) DO NOTHING;

  -- ── 8. 연설문 작성 비서 ─────────────────────────────────────
  INSERT INTO agents (
    department_id, name, description, system_prompt,
    config, is_active, category, icon, color, is_personal, owner_id
  ) VALUES (
    v_dept_id,
    '연설문 작성 비서',
    '행사명·대상·메시지로 기관장/담당자용 연설문 초안을 작성합니다.',
    '행사명, 대상, 주요 메시지를 알려주면
기관장/담당자용 연설문 초안을 작성합니다.
격식체, 3~5분 분량(A4 1.5장),
도입-본론-결론 구조, 기관의 비전과 연결.',
    '{}'::jsonb, true, '공공기관', '🎤', '#6B4226', false, null
  )
  ON CONFLICT (department_id, name) DO NOTHING;

  RAISE NOTICE '✅ 공공기관 특화 비서 8개 삽입 완료 (중복 시 건너뜀)';

END $$;


-- =============================================================
-- 확인 쿼리: 삽입된 비서 목록 조회
-- =============================================================
SELECT
  a.name,
  a.icon,
  a.color,
  a.category,
  a.is_personal,
  a.is_active,
  left(a.system_prompt, 40) || '…' AS prompt_preview,
  d.name AS department_name
FROM agents a
JOIN departments d ON d.id = a.department_id
WHERE a.category = '공공기관'
  AND a.is_personal = false
ORDER BY a.created_at DESC;
