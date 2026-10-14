// src/lib/agent-patch.ts
import { parseCatalogFields, type AgentType } from '@/lib/agent-catalog';
import { normalizeCapabilities, type CapabilitySettings } from '@/lib/capabilities/settings';

/**
 * 비서 수정 요청을 두 갈래로 나눈다.
 *
 * - 판 설정: 판 사본에 들어가고 save_agent로만 바꾼다(되돌리기 대상)
 * - 운영 값: 노출·정렬·공개 범위·사용 여부·유형. 운영자가 조정하는 값이라
 *   되돌리기가 건드리면 안 된다(설계 2.4)
 *
 * SNAPSHOT_KEYS는 0026의 agent_snapshot()과 같아야 한다.
 */
export const SNAPSHOT_KEYS = [
  'name', 'description', 'icon', 'color', 'category', 'usage_guide',
  'starter_prompts', 'system_prompt', 'model_id', 'capabilities', 'template_ids',
] as const;

export interface AgentSettingsPatch {
  name?: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  category?: string | null;
  usage_guide?: string | null;
  starter_prompts?: string[] | null;
  system_prompt?: string | null;
  model_id?: string | null;
  capabilities?: CapabilitySettings;
  /** 양식 라우트만 채운다. 요청 본문으로는 받지 않는다. */
  template_ids?: string[];
}

export interface SplitResult {
  settings: AgentSettingsPatch;
  operational: Record<string, unknown>;
  error?: string;
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function splitAgentBody(
  body: Record<string, unknown>,
  opts: { currentType: AgentType; knownConnectorIds: string[]; knownModelIds: string[] }
): SplitResult {
  const result: SplitResult = { settings: {}, operational: {} };
  const fail = (error: string): SplitResult => ({ ...result, error });

  if (body.enabled_connectors !== undefined) {
    return fail('enabled_connectors는 더 이상 받지 않습니다. capabilities.public_data로 보내 주세요.');
  }
  if (body.template_ids !== undefined) {
    return fail('양식은 양식 관리에서 바꿔 주세요.');
  }

  // 아이콘·카테고리·안내·예시·유형·주소 검사는 생성과 수정이 같은 규칙을 쓴다
  const { payload: catalog, error } = parseCatalogFields(body, opts.currentType);
  if (error) return fail(error);

  if (catalog.icon !== undefined) result.settings.icon = catalog.icon;
  if (catalog.category !== undefined) result.settings.category = catalog.category;
  if (catalog.usage_guide !== undefined) result.settings.usage_guide = catalog.usage_guide;
  if (catalog.starter_prompts !== undefined) result.settings.starter_prompts = catalog.starter_prompts;
  if (catalog.is_published !== undefined) result.operational.is_published = catalog.is_published;
  if (catalog.display_order !== undefined) result.operational.display_order = catalog.display_order;
  if (catalog.agent_type !== undefined) result.operational.agent_type = catalog.agent_type;
  if (catalog.link_url !== undefined) result.operational.link_url = catalog.link_url;

  if (body.name !== undefined) {
    const name = textOrNull(body.name);
    if (!name) return fail('비서 이름은 비워 둘 수 없습니다.');
    result.settings.name = name;
  }
  if (body.description !== undefined) result.settings.description = textOrNull(body.description);
  if (body.system_prompt !== undefined) result.settings.system_prompt = textOrNull(body.system_prompt);
  if (body.color !== undefined) result.settings.color = textOrNull(body.color);

  if (body.model_id !== undefined) {
    if (body.model_id === null || body.model_id === '') {
      result.settings.model_id = null; // 기관 기본 모델
    } else if (typeof body.model_id === 'string' && opts.knownModelIds.includes(body.model_id)) {
      result.settings.model_id = body.model_id;
    } else {
      return fail('등록되지 않은 모델입니다.');
    }
  }

  if (body.capabilities !== undefined) {
    const normalized = normalizeCapabilities(body.capabilities, { knownConnectorIds: opts.knownConnectorIds });
    if (!normalized.ok) return fail(normalized.message);
    result.settings.capabilities = normalized.value;
  }

  if (body.visibility !== undefined) {
    if (body.visibility !== 'organization' && body.visibility !== 'department') {
      return fail("공개 범위는 'organization' 또는 'department'만 가능합니다.");
    }
    result.operational.visibility = body.visibility;
  }
  if (body.is_active !== undefined) result.operational.is_active = Boolean(body.is_active);

  return result;
}

/**
 * 폼·주소로 받은 판 번호. 숫자만 있는 문자열일 때만 받고 아니면 null.
 *
 * Number('')와 Number(null)은 0이라 `Number.isInteger(Number(raw))`로는 빈 값과
 * 누락이 판 0으로 통과한다. 판 0은 늘 충돌로 거절되긴 하지만, 사용자는 원인 대신
 * "다른 분이 먼저 고쳤습니다"를 보게 된다.
 */
export function parseBaseVersion(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * 객체 키를 정렬해 직렬화한다. jsonb는 키 순서를 바꿔 돌려주므로 순서에 기대면
 * 같은 값도 바뀐 것으로 보인다. 배열 순서는 그대로 둔다(커넥터 순서는 실제 변경).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const body = Object.keys(record)
    .sort()
    .filter((k) => record[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`);
  return `{${body.join(',')}}`;
}

/** 같은 값을 다시 보낸 저장으로 빈 판이 쌓이지 않게 한다. */
export function changedSettingKeys(current: Record<string, unknown>, patch: AgentSettingsPatch): string[] {
  return Object.entries(patch)
    .filter(([key, value]) => stableStringify(value ?? null) !== stableStringify(current[key] ?? null))
    .map(([key]) => key);
}
