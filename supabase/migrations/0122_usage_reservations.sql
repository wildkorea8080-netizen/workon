-- 0122: 입력형 앱 실행의 사용량 예약(2026-11-26)
--
-- 앱 실행은 모델을 여러 번 부른다(중간 단계·분류·반복·긴 첨부 추리기). 예전엔 시작할 때 한도가 '아직 남았는지'만 보고, 단계마다
-- 다시 봐서 도중에 한도에 닿으면 멈췄다 — 그때까지 쓴 금액은 결과 없이 사라지고, 거의 동시에 시작한 실행·대화가 같은 여유를 함께 썼다.
-- 이제 실행을 시작하기 전에 그 실행이 많으면 쓸 금액(예상 호출 수 × 모델 단가 — src/lib/usage-reservation.ts)을 금액 한도
-- (부서·개인 월 한도, 연간 정액 계약)에 예약한다. 남은 금액에서 다른 실행의 예약을 빼고도 모자라면 시작하지 않는다.
-- 다른 대화·실행의 한도 판정(checkTokenLimit)도 살아 있는 예약을 쓴 것으로 센다(자기 실행의 예약은 빼고).
-- 실행이 끝나면 예약을 지우고, 끊긴 실행의 예약은 기한(expires_at)이 지나면 세지 않는다(다음 예약 때 치운다).
--
-- 예약은 함수(usage_reserve) 한 번 — 기관마다 잠금(트랜잭션 advisory lock)을 잡고 살아 있는 예약을 세어 넣으므로,
-- 거의 동시에 시작한 두 실행이 같은 여유를 두 번 예약하지 못한다. 남은 금액(한도 − 쓴 금액)은 앱이 계산해 넘긴다(p_checks).
--
-- 추가만, 여러 번 적용해도 안전, RLS 켜고 정책 없음·공개 키 권한 없음, 함수 실행 권한 service_role만.
-- 코드 배포 전에 적용 — 없으면 예약을 못 해 예약 없이 실행하고(운영 기록), 한도 판정은 예약을 세지 못한 채 돈다(예전과 같다).
CREATE TABLE IF NOT EXISTS public.usage_reservations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  department_id   uuid REFERENCES public.departments(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES public.users(id) ON DELETE CASCADE,
  amount_krw      numeric(14, 2) NOT NULL CHECK (amount_krw > 0 AND amount_krw <= 10000000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '1 hour')
);

CREATE INDEX IF NOT EXISTS usage_reservations_org_idx ON public.usage_reservations (organization_id, expires_at);

ALTER TABLE public.usage_reservations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON public.usage_reservations FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON public.usage_reservations FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.usage_reservations TO service_role';
  END IF;
END $$;

-- p_checks: [{ "scope": "department" | "user" | "organization", "headroom": 남은 금액(원) }] — 그 범위의 살아 있는 예약 합 + p_amount가
-- 남은 금액을 넘으면 넣지 않고 { ok: false, scope, headroom, reserved }, 아니면 넣고 { ok: true, id }.
-- 범위의 열쇠는 이 함수의 인자(부서·직원·기관)다 — 부르는 쪽이 다른 범위의 열쇠를 섞지 못하게
CREATE OR REPLACE FUNCTION public.usage_reserve(
  p_organization_id uuid, p_department_id uuid, p_user_id uuid, p_amount numeric, p_checks jsonb, p_expires_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_check jsonb;
  v_scope text;
  v_headroom numeric;
  v_reserved numeric;
  v_id uuid;
BEGIN
  IF p_organization_id IS NULL OR p_amount IS NULL OR p_amount <= 0 OR p_expires_at IS NULL OR jsonb_typeof(p_checks) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'usage_reserve: bad input' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('usage_reserve:' || p_organization_id::text, 0));
  DELETE FROM public.usage_reservations WHERE organization_id = p_organization_id AND expires_at <= now();
  FOR v_check IN SELECT * FROM jsonb_array_elements(p_checks) LOOP
    v_scope := v_check->>'scope';
    v_headroom := (v_check->>'headroom')::numeric;
    IF v_scope NOT IN ('department', 'user', 'organization') OR v_headroom IS NULL
       OR (v_scope = 'department' AND p_department_id IS NULL) OR (v_scope = 'user' AND p_user_id IS NULL) THEN
      RAISE EXCEPTION 'usage_reserve: bad check' USING ERRCODE = '22023';
    END IF;
    SELECT coalesce(sum(r.amount_krw), 0) INTO v_reserved FROM public.usage_reservations r
     WHERE r.organization_id = p_organization_id AND r.expires_at > now()
       AND (v_scope = 'organization' OR (v_scope = 'department' AND r.department_id = p_department_id) OR (v_scope = 'user' AND r.user_id = p_user_id));
    IF v_reserved + p_amount > v_headroom THEN
      RETURN jsonb_build_object('ok', false, 'scope', v_scope, 'headroom', v_headroom, 'reserved', v_reserved);
    END IF;
  END LOOP;
  INSERT INTO public.usage_reservations (organization_id, department_id, user_id, amount_krw, expires_at)
  VALUES (p_organization_id, p_department_id, p_user_id, p_amount, p_expires_at)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;

REVOKE ALL ON FUNCTION public.usage_reserve(uuid, uuid, uuid, numeric, jsonb, timestamptz) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.usage_reserve(uuid, uuid, uuid, numeric, jsonb, timestamptz) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.usage_reserve(uuid, uuid, uuid, numeric, jsonb, timestamptz) FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.usage_reserve(uuid, uuid, uuid, numeric, jsonb, timestamptz) TO service_role';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
