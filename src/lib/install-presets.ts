import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  presetsForOrganizationType,
  PRESET_CATEGORIES,
  type AgentPreset,
} from '@/lib/agent-presets';

/**
 * 기관에 기본 비서 세트를 설치한다 (P3-2).
 *
 * 새 기관이 빈 화면에서 시작하면 무엇부터 해야 할지 알 수 없다. 웍스AI가
 * 조직 유형 선택만으로 비서 8종을 깔아 주는 것과 같은 자리다.
 *
 * 여러 번 불러도 안전하다 — 같은 이름의 비서가 있으면 건너뛴다.
 * 기관을 만들다 중간에 실패해 다시 시도하는 경우가 실제로 생긴다.
 */

export interface InstallResult {
  installed: number;
  skipped: number;
  categories: number;
}

export async function installPresetAgents(
  organizationId: string,
  departmentId: string,
  organizationType: string | null | undefined
): Promise<InstallResult> {
  const presets = presetsForOrganizationType(organizationType);

  // ── 카테고리 ──
  // 관리 화면 드롭다운은 agent_categories를 읽는다. 여기 없으면 비서에 붙은
  // category 값이 선택지로 나오지 않아 관리자가 바꿀 수 없게 된다.
  let categories = 0;
  for (let i = 0; i < PRESET_CATEGORIES.length; i += 1) {
    const { error } = await supabaseAdmin
      .from('agent_categories')
      .insert({ organization_id: organizationId, name: PRESET_CATEGORIES[i], display_order: i });
    // 23505 = 이미 있음. 재시도 상황에서 정상이다.
    if (!error) categories += 1;
    else if (error.code !== '23505') {
      console.warn('[install-presets] 카테고리 추가 실패', PRESET_CATEGORIES[i], error.message);
    }
  }

  // ── 비서 ──
  const orderByCategory = new Map<string, number>();
  let installed = 0;
  let skipped = 0;

  for (const preset of presets) {
    const order = orderByCategory.get(preset.category) ?? 0;
    orderByCategory.set(preset.category, order + 1);

    const { error } = await supabaseAdmin.from('agents').insert(buildRow(preset, departmentId, order));

    if (!error) {
      installed += 1;
    } else if (error.code === '23505') {
      skipped += 1;
    } else {
      // 한 개가 실패해도 나머지는 깐다. 전부 되돌리면 기관이 빈 채로 남는다.
      console.warn('[install-presets] 비서 추가 실패', preset.name, error.message);
      skipped += 1;
    }
  }

  return { installed, skipped, categories };
}

function buildRow(preset: AgentPreset, departmentId: string, order: number) {
  return {
    department_id: departmentId,
    name: preset.name,
    description: preset.description,
    system_prompt: preset.systemPrompt,
    config: {},
    is_active: true,
    // 큐레이션한 세트라 바로 쓸 수 있게 노출한다. 관리자가 직접 만드는 비서는
    // 0019 기본값에 따라 '노출 대기중'에서 시작한다 — 성격이 다르다.
    is_published: true,
    // 범용 비서라 부서를 가릴 이유가 없다. 전 직원이 쓴다.
    visibility: 'organization',
    category: preset.category,
    icon: preset.icon,
    color: preset.color,
    display_order: order,
    agent_type: 'chat',
    is_personal: false,
    owner_id: null,
    enabled_connectors: preset.connectors ?? [],
  };
}
