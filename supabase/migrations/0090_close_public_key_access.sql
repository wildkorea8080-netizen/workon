-- 0090: 공개 키(anon)·Supabase 로그인 토큰(authenticated)으로 public 스키마를 읽고 쓰던 길 닫기 (2026-11-13)
--
-- 브라우저에 실린 공개 키(NEXT_PUBLIC_SUPABASE_ANON_KEY)만 있으면 PostgREST로 다음을 할 수 있었다(운영 DB에서 확인, 2026-11-13):
--   · RLS가 꺼진 표 여섯(agent_history·agent_templates·chat_attachments·common_documents·generated_files·schema_migrations)을
--     읽고 쓰고 지우기 — anon에 SELECT·INSERT·UPDATE·DELETE 권한이 있었다. 예: 모든 기관 비서의 판 사본(지시문 포함) 48행,
--     직원 첨부 파일 이름·요약 3행이 읽혔고, 공통 자료실에 가짜 '정부 기준 문서' 행을 넣을 수 있었다.
--   · 뷰(v_organization_summary·v_monthly_billing) 읽기 — 뷰는 만든 사람 권한으로 돌아 RLS를 건너뛴다(기관 이름·도메인·담당자 이름·메일·요금).
--   · departments 읽기 — 대시보드에서 만든 정책 departments_select_all(역할 public).
-- 마이그레이션 밖에서 만든 옛 정책들(역할 public — agents·conversations·documents·forbidden_words·messages·report_templates·usage_logs·users)도
-- 남아 있었다. 공개 가입한 Supabase 계정의 토큰(authenticated)에 걸리는 길이고, 서로 불러 42P17(무한 재귀)로 실패하기도 한다.
--
-- 앱은 표를 서버의 서비스 키(supabaseAdmin — RLS를 건너뜀)로만 읽고 쓴다. 공개 키 클라이언트는 로그인·가입(supabase.auth)과
-- 저장소 서명 올리기(storage 스키마)에만 쓰고, 미들웨어도 2026-11-13부터 서비스 키로 읽는다(src/lib/middleware-db.ts).
-- 그래서 아래를 해도 앱은 그대로 돈다:
--   1. public 스키마의 모든 표에 RLS를 켠다(정책이 없으면 anon·authenticated는 0행·쓰기 거절, service_role은 그대로)
--   2. public 스키마에서 public·anon·authenticated 역할에 걸린 정책을 모두 지운다
--   3. anon·authenticated의 public 스키마 표·뷰·시퀀스 권한을 거두고, 앞으로 만들 것에도 기본으로 주지 않는다
--      (TRUNCATE는 RLS가 막지 못하고, 뷰는 RLS를 건너뛰므로 권한 자체를 거둔다)
-- 함수 실행 권한은 건드리지 않는다(새 함수는 이미 service_role만). storage 스키마(저장소 정책)도 건드리지 않는다.
-- 여러 번 적용해도 안전하다. anon·authenticated 역할이 없는 DB(시험 DB)에서는 3을 건너뛴다.

DO $$
DECLARE
  r record;
BEGIN
  -- 1. RLS 켜기
  FOR r IN
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
  END LOOP;

  -- 2. 공개·로그인 토큰 역할에 걸린 정책 지우기
  FOR r IN
    SELECT tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public' AND roles && ARRAY['public', 'anon', 'authenticated']::name[]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, r.tablename);
  END LOOP;

  -- 3. 권한 거두기
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM authenticated';
  END IF;
END $$;
