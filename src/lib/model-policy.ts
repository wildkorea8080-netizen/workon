import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { MODELS, DEFAULT_MODEL_ID, enabledModels, type ModelDefinition } from '@/lib/models';

/**
 * 기관별 허용 모델 정책 (0021).
 *
 * 모델을 늘리기 **전에** 정책을 넣는다. 순서가 반대면, 정책이 붙기까지의
 * 기간에 쌓인 사용 내역을 보안성 검토에서 설명할 수 없다. 공공기관은
 * "어떤 데이터가 어느 사업자에게 갔는지"를 전부 소명해야 한다.
 *
 * 지금은 모델이 하나뿐이라 이 계층이 하는 일이 거의 없어 보이지만, 그게
 * 요점이다 — 두 번째 모델이 붙는 순간부터 자동으로 구속력을 갖는다.
 */

/** 허용 목록을 정하지 않은 기관이 쓸 수 있는 모델. */
export const POLICY_FALLBACK_MODEL_ID = DEFAULT_MODEL_ID;

/**
 * 기관이 실제로 쓸 수 있는 모델 id 목록.
 *
 * 세 경우를 구분한다.
 *   NULL   아직 정하지 않음 → 기본 모델만. 열어 두는 쪽으로 기울지 않는다
 *   [...]  그 목록. 단 레지스트리에 없거나 꺼진 모델은 걸러낸다
 *   []     아무것도 없음 → 기본 모델로 되돌린다. 빈 목록을 그대로 두면
 *          그 기관은 아무 대화도 못 하게 잠긴다
 */
export async function getAllowedModelIds(organizationId: string | null | undefined): Promise<string[]> {
  const usable = new Set(enabledModels().map((m) => m.id));

  if (!organizationId) return [POLICY_FALLBACK_MODEL_ID];

  const { data, error } = await supabaseAdmin
    .from('organizations')
    .select('allowed_models')
    .eq('id', organizationId)
    .maybeSingle();

  // 조회 실패가 범위를 넓히면 안 된다. 가장 좁은 쪽으로 닫는다.
  if (error) {
    console.warn('[model-policy] 허용 모델 조회 실패:', error.message);
    return [POLICY_FALLBACK_MODEL_ID];
  }

  const configured = data?.allowed_models;
  if (!Array.isArray(configured)) return [POLICY_FALLBACK_MODEL_ID];

  // 레지스트리에서 사라졌거나 꺼진 모델이 남아 있을 수 있다.
  // 지난 정책을 그대로 믿으면 없는 모델을 호출하게 된다.
  const valid = configured.filter((id) => typeof id === 'string' && usable.has(id));

  return valid.length > 0 ? valid : [POLICY_FALLBACK_MODEL_ID];
}

/**
 * 요청된 모델을 정책에 비춰 확정한다.
 *
 * 화면에서 걸러 보내더라도 그건 표시일 뿐이다. 실제 제한은 여기서 건다 —
 * 개인 비서 커넥터 범위(`connector-scope.ts`)와 같은 원칙이다.
 */
export function resolveModel(requested: string | null | undefined, allowed: string[]): {
  modelId: string;
  /** 요청이 정책에 막혀 다른 모델로 바뀌었는지. 로그에 남길 때 쓴다. */
  substituted: boolean;
} {
  const fallback = allowed[0] ?? POLICY_FALLBACK_MODEL_ID;

  if (!requested) return { modelId: fallback, substituted: false };
  if (allowed.includes(requested)) return { modelId: requested, substituted: false };

  return { modelId: fallback, substituted: true };
}

/**
 * 부서 id로부터 쓸 모델을 확정한다.
 *
 * 토큰을 쓰는 라우트가 각자 기관을 조회하고 정책을 적용하면 한 곳만
 * 빠뜨려도 그 경로가 정책 밖으로 샌다. 여기 한 줄로 끝나게 둔다.
 */
export async function resolveModelForDepartment(
  departmentId: string | null | undefined,
  requested?: string | null
): Promise<string> {
  if (!departmentId) return POLICY_FALLBACK_MODEL_ID;

  const { data } = await supabaseAdmin
    .from('departments')
    .select('organization_id')
    .eq('id', departmentId)
    .maybeSingle();

  const allowed = await getAllowedModelIds(data?.organization_id);
  return resolveModel(requested, allowed).modelId;
}

/** 화면에 보여줄 형태. 단가는 담당자가 비용을 가늠하는 근거가 된다. */
export function describeModels(ids: string[]): ModelDefinition[] {
  return ids.map((id) => MODELS[id]).filter((m): m is ModelDefinition => Boolean(m));
}
