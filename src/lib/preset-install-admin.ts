// src/lib/preset-install-admin.ts
// 기관 관리자 '기본 비서·앱 세트'(2026-11-07) — 이 기관에 아직 없는 기본 비서·입력형 앱을 보고 골라 설치한다.
// 전에는 기관을 만들 때만 깔리고, 나중에 더한 기본 앱은 운영자가 `npm run seed:agents`를 돌려야 받았다.
// 이름이 같은 비서가 있는지는 **기관 전체**로 본다 — DB 유일 색인은 부서 안(`agents_shared_name_idx`)이라
// 설치 함수에만 맡기면 다른 부서에 같은 이름의 비서가 있어도 한 벌 더 깔린다.
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { presetsForOrganizationType, type AgentPreset } from '@/lib/agent-presets';
import { installPresetAgents, type InstallResult } from '@/lib/install-presets';

export type PresetStatusItem = {
  name: string;
  description: string;
  category: string;
  icon: string;
  kind: 'chat' | 'form';
  installed: boolean;
};

/** 기관 안의 지우지 않은 공식·부서 비서 이름 — 나만의 비서는 세지 않는다(그 사람만 보는 것) */
export type ExistingNames = (organizationId: string, names: string[]) => Promise<Set<string>>;

export const existingSharedNames: ExistingNames = async (organizationId, names) => {
  const { data, error } = await supabaseAdmin
    .from('agents')
    .select('name')
    .eq('organization_id', organizationId)
    .neq('tier', 'personal')
    .is('deleted_at', null)
    .in('name', names);
  if (error) throw new Error(`agents: ${error.message}`);
  return new Set(((data ?? []) as { name: string }[]).map((r) => r.name));
};

export function presetStatusItems(presets: AgentPreset[], existing: Set<string>): PresetStatusItem[] {
  return presets.map((p) => ({
    name: p.name,
    description: p.description,
    category: p.category,
    icon: p.icon,
    kind: p.appDefinition ? 'form' : 'chat',
    installed: existing.has(p.name),
  }));
}

export async function presetStatus(organizationId: string, organizationType: string | null, existing: ExistingNames = existingSharedNames): Promise<PresetStatusItem[]> {
  const presets = presetsForOrganizationType(organizationType);
  return presetStatusItems(presets, await existing(organizationId, presets.map((p) => p.name)));
}

/**
 * 고른 기본 비서·앱을 설치한다 — 세트에 없는 이름은 거절, 이미 있는 것은 건너뛴다(기관 전체로 다시 확인).
 * 설치는 요청자 부서(기관 전체 관리자 = 최상위 부서)에, 공개 범위는 기관 전체(기본 세트 규칙 그대로)
 */
export async function installChosenPresets(
  args: { organizationId: string; organizationType: string | null; departmentId: string; names: string[] },
  deps: { existing?: ExistingNames; install?: typeof installPresetAgents } = {},
): Promise<{ ok: true; installed: string[]; failed: string[]; skipped: string[]; result: InstallResult | null } | { ok: false; message: string }> {
  const presets = presetsForOrganizationType(args.organizationType);
  const known = new Set(presets.map((p) => p.name));
  const names = [...new Set(args.names)];
  if (!names.length || names.some((n) => !known.has(n))) return { ok: false, message: '기본 세트에 있는 비서·앱만 고를 수 있습니다.' };
  const existing = await (deps.existing ?? existingSharedNames)(args.organizationId, names);
  const missing = names.filter((n) => !existing.has(n));
  const skipped = names.filter((n) => existing.has(n));
  if (!missing.length) return { ok: true, installed: [], failed: [], skipped, result: null };
  const result = await (deps.install ?? installPresetAgents)(args.organizationId, args.departmentId, args.organizationType, { only: missing });
  // 설치 함수는 하나가 실패해도 나머지를 깔고 개수만 돌려준다 — 무엇이 깔렸는지는 다시 읽어 정한다
  const after = await (deps.existing ?? existingSharedNames)(args.organizationId, missing);
  return { ok: true, installed: missing.filter((n) => after.has(n)), failed: missing.filter((n) => !after.has(n)), skipped, result };
}
