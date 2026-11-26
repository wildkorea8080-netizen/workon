-- 0121: 기관 SSO back-channel 로그아웃 — sid가 온 로그아웃은 그 세션 하나만 끝낸다(2026-11-26)
--
-- 0118까지는 계정 서비스가 세션 번호(sid)를 보내도 그 직원의 기관 계정 로그인을 모두 끝냈다(WORKON 로그인에 sid를 싣지 않아서).
-- 이제 기관 계정으로 로그인할 때 id_token의 sid를 WORKON 로그인(토큰 ssoSid)에 싣고, sid가 온 로그아웃이면 직원 행의
-- '끝낸 세션' 목록(users.sso_ended_sessions — `{로그아웃 초}:{sid}`, 최근 20개)에 그 하나만 더한다. 미들웨어는 이미 읽는 직원 행에서
-- 이 목록을 함께 읽어 그 sid로, 그때나 그 전에 들어온 로그인만 끝낸다(src/lib/middleware-db.ts `userSessionVerdict`).
--
-- sid를 싣지 않은 기관 계정 로그인(이 배포 전 로그인·id_token에 sid가 없던 로그인)은 어느 세션인지 모르므로 예전처럼 끝낸다 —
-- 그 기준 시각이 users.sso_sid_logout_at(sid로 받은 로그아웃의 가장 늦은 때). sub만 온 로그아웃은 그대로 sso_logout_at(모두 끝냄, 0114).
--
-- 목록 더하기는 함수(sso_end_session) 한 번으로 — 거의 동시에 온 두 로그아웃이 서로를 덮지 않게 행 하나를 한 문장으로 바꾼다.
-- 바꿨으면 그 직원의 부서 한 줄(보안 로그용 — 부서가 없으면 NULL 한 줄), 이미 있는 항목(같은 토큰이 다시 옴)이면 줄 없음. 탈퇴 처리된 직원은 바꾸지 않는다.
--
-- 추가만, 여러 번 적용해도 안전. 함수 실행 권한 service_role만.
-- **코드 배포 전에 반드시 적용** — 새 미들웨어가 모든 직원 요청에서 두 칸을 select 해, 없으면 계정 상태를 못 읽어 열림으로 돈다
-- (비활성·탈퇴·권한 변경 끊기까지 빠진다).
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS sso_ended_sessions text[] NOT NULL DEFAULT '{}';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS sso_sid_logout_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_sso_ended_sessions_check' AND conrelid = 'public.users'::regclass) THEN
    ALTER TABLE public.users ADD CONSTRAINT users_sso_ended_sessions_check CHECK (cardinality(sso_ended_sessions) <= 20);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.sso_end_session(p_user_id uuid, p_sid text, p_at timestamptz)
RETURNS TABLE (department_id uuid)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_entry text;
BEGIN
  IF p_sid IS NULL OR char_length(p_sid) NOT BETWEEN 1 AND 255 OR p_at IS NULL THEN
    RAISE EXCEPTION 'sso_end_session: bad input' USING ERRCODE = '22023';
  END IF;
  v_entry := floor(extract(epoch FROM p_at))::bigint::text || ':' || p_sid;
  UPDATE public.users u SET
    sso_ended_sessions = (
      SELECT CASE WHEN cardinality(a) > 20 THEN a[cardinality(a) - 19 : cardinality(a)] ELSE a END
      FROM (SELECT array_append(coalesce(u.sso_ended_sessions, '{}'), v_entry) AS a) x
    ),
    sso_sid_logout_at = greatest(coalesce(u.sso_sid_logout_at, p_at), p_at)
  WHERE u.id = p_user_id AND u.deleted_at IS NULL AND NOT (v_entry = ANY (coalesce(u.sso_ended_sessions, '{}')))
  RETURNING u.department_id INTO department_id;
  IF FOUND THEN
    RETURN NEXT;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.sso_end_session(uuid, text, timestamptz) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.sso_end_session(uuid, text, timestamptz) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.sso_end_session(uuid, text, timestamptz) FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.sso_end_session(uuid, text, timestamptz) TO service_role';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
