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
  /** --update로 프롬프트를 갱신한 수 */
  updated: number;
  /** 사람이 손댄 흔적이 있어 건드리지 않은 비서 이름 */
  preserved: string[];
}

export interface InstallOptions {
  /**
   * 이미 있는 비서의 프롬프트를 프리셋으로 갱신할지.
   *
   * 기본값(false)은 건너뛴다. 그런데 그러면 프리셋을 개선해도 이미 만들어진
   * 기관은 옛 프롬프트를 그대로 쓴다 — 실제로 기관 두 곳의 같은 이름 비서가
   * 서로 다른 프롬프트를 갖게 됐다(민원인 답변: 89자 vs 211자).
   *
   * true로 주면 갱신하되, **사람이 손댄 비서는 건드리지 않는다.**
   * 판정은 `updated_by`가 채워져 있는지로 한다 — 관리 화면의 수정·노출 토글이
   * 모두 이 값을 남긴다. 관리자가 기관 사정에 맞춰 고쳐 둔 문구를 덮으면
   * 되돌릴 방법이 없으므로, 애매하면 건드리지 않는 쪽으로 판단한다.
   */
  update?: boolean;
}

export async function installPresetAgents(
  organizationId: string,
  departmentId: string,
  organizationType: string | null | undefined,
  options: InstallOptions = {}
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
  let updated = 0;
  const preserved: string[] = [];

  for (const preset of presets) {
    const order = orderByCategory.get(preset.category) ?? 0;
    orderByCategory.set(preset.category, order + 1);

    const { error } = await supabaseAdmin.from('agents').insert(buildRow(preset, departmentId, order));

    if (!error) {
      installed += 1;
      continue;
    }

    if (error.code !== '23505') {
      // 한 개가 실패해도 나머지는 깐다. 전부 되돌리면 기관이 빈 채로 남는다.
      console.warn('[install-presets] 비서 추가 실패', preset.name, error.message);
      skipped += 1;
      continue;
    }

    // 이미 있는 비서
    if (!options.update) {
      skipped += 1;
      continue;
    }

    const { data: existing } = await supabaseAdmin
      .from('agents')
      .select('id, updated_by')
      .eq('organization_id', organizationId)
      .eq('name', preset.name)
      .eq('is_personal', false)
      .maybeSingle();

    if (!existing) {
      skipped += 1;
      continue;
    }

    // 사람이 손댄 흔적이 있으면 그대로 둔다. 기관 사정에 맞춰 고쳐 둔 문구를
    // 덮으면 되돌릴 방법이 없다.
    if (existing.updated_by) {
      preserved.push(preset.name);
      skipped += 1;
      continue;
    }

    // 갱신 대상은 프리셋이 정의하는 것들뿐이다. 노출 여부·공개 범위·정렬처럼
    // 운영자가 조정하는 값은 건드리지 않는다.
    const { error: updateError } = await supabaseAdmin
      .from('agents')
      .update({
        description: preset.description,
        system_prompt: preset.systemPrompt,
        icon: preset.icon,
        color: preset.color,
        category: preset.category,
        enabled_connectors: preset.connectors ?? [],
      })
      .eq('id', existing.id);

    if (updateError) {
      console.warn('[install-presets] 비서 갱신 실패', preset.name, updateError.message);
      skipped += 1;
    } else {
      updated += 1;
    }
  }

  return { installed, skipped, categories, updated, preserved };
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
