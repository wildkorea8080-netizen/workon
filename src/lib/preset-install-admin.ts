// src/lib/preset-install-admin.ts
// 기관 관리자 '기본 비서·앱 세트'(2026-11-07) — 이 기관에 아직 없는 기본 비서·입력형 앱을 보고 골라 설치한다.
// 전에는 기관을 만들 때만 깔리고, 나중에 더한 기본 앱은 운영자가 `npm run seed:agents`를 돌려야 받았다.
// 이름이 같은 비서가 있는지는 **기관 전체**로 본다 — DB 유일 색인은 부서 안(`agents_shared_name_idx`)이라
// 설치 함수에만 맡기면 다른 부서에 같은 이름의 비서가 있어도 한 벌 더 깔린다.
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { presetsForOrganizationType, type AgentPreset } from '@/lib/agent-presets';
import { installPresetAgents, presetSettingsPatch, type InstallResult } from '@/lib/install-presets';
import { saveAgentSettings } from '@/lib/agent-store';

export type PresetStatusItem = {
  name: string;
  description: string;
  category: string;
  icon: string;
  kind: 'chat' | 'form';
  installed: boolean;
  /**
   * 깔린 것과 지금 세트의 관계(2026-11-07) — `missing` 없음 · `current` 같음 · `outdated` 사람이 고치지 않았는데 내용이 다름(갱신 가능) ·
   * `edited` 관리자가 고친 비서(갱신하지 않음) · `manual` 같은 이름이 여럿이거나 공식 비서가 아님(갱신하지 않음)
   */
  state: PresetState;
};
export type PresetState = 'missing' | 'current' | 'outdated' | 'edited' | 'manual';

/** 갱신 판정에 쓰는 행 — 프리셋이 정하는 칸 + 판·고친 사람 */
export type PresetRow = {
  id: string; name: string; tier: string; version: number; updated_by: string | null;
  description: string | null; system_prompt: string | null; icon: string | null; color: string | null; category: string | null;
  capabilities: unknown; app_definition: unknown;
};
export type ExistingRows = (organizationId: string, names: string[]) => Promise<PresetRow[]>;

export const existingSharedRows: ExistingRows = async (organizationId, names) => {
  const { data, error } = await supabaseAdmin
    .from('agents')
    .select('id, name, tier, version, updated_by, description, system_prompt, icon, color, category, capabilities, app_definition')
    .eq('organization_id', organizationId)
    .neq('tier', 'personal')
    .is('deleted_at', null)
    .in('name', names);
  if (error) throw new Error(`agents: ${error.message}`);
  return (data ?? []) as PresetRow[];
};

/** 열쇠 순서와 상관없이 같은 값인가 — jsonb는 열쇠 순서를 바꿔 저장한다 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

export function presetState(preset: AgentPreset, rows: PresetRow[]): PresetState {
  const mine = rows.filter((r) => r.name === preset.name);
  if (!mine.length) return 'missing';
  if (mine.length > 1 || mine[0].tier !== 'official') return 'manual';
  const row = mine[0];
  const patch = presetSettingsPatch(preset, row.capabilities) as Record<string, unknown>;
  const same = Object.keys(patch).every((key) => canonical(patch[key]) === canonical((row as unknown as Record<string, unknown>)[key]));
  if (same) return 'current';
  return row.updated_by ? 'edited' : 'outdated';
}

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

export function presetStatusItems(presets: AgentPreset[], rows: PresetRow[]): PresetStatusItem[] {
  return presets.map((p) => {
    const state = presetState(p, rows);
    return { name: p.name, description: p.description, category: p.category, icon: p.icon, kind: p.appDefinition ? 'form' : 'chat', installed: state !== 'missing', state };
  });
}

export async function presetStatus(organizationId: string, organizationType: string | null, rows: ExistingRows = existingSharedRows): Promise<PresetStatusItem[]> {
  const presets = presetsForOrganizationType(organizationType);
  return presetStatusItems(presets, await rows(organizationId, presets.map((p) => p.name)));
}

/**
 * 고른 기본 비서·앱을 지금 세트 내용으로 갱신한다 — `outdated`(사람이 고치지 않았는데 내용이 다름)만. 판으로 남긴다(`save_agent`, `preset_update`).
 * 관리자가 고친 비서(`updated_by`)·이름이 여럿인 비서는 건드리지 않는다(스크립트 `--update`와 같은 규칙). 노출·공개 범위·정렬은 바꾸지 않는다
 */
export async function updateChosenPresets(
  args: { organizationId: string; organizationType: string | null; names: string[] },
  deps: { rows?: ExistingRows; save?: typeof saveAgentSettings } = {},
): Promise<{ ok: true; updated: string[]; skipped: string[]; failed: string[] } | { ok: false; message: string }> {
  const presets = presetsForOrganizationType(args.organizationType);
  const names = [...new Set(args.names)];
  const chosen = names.map((n) => presets.find((p) => p.name === n));
  if (!names.length || chosen.some((p) => !p)) return { ok: false, message: '기본 세트에 있는 비서·앱만 고를 수 있습니다.' };
  const rows = await (deps.rows ?? existingSharedRows)(args.organizationId, names);
  const updated: string[] = []; const skipped: string[] = []; const failed: string[] = [];
  for (const preset of chosen as AgentPreset[]) {
    if (presetState(preset, rows) !== 'outdated') { skipped.push(preset.name); continue; }
    const row = rows.find((r) => r.name === preset.name)!;
    const saved = await (deps.save ?? saveAgentSettings)(row.id, row.version, presetSettingsPatch(preset, row.capabilities), null, 'preset_update');
    (saved.ok ? updated : failed).push(preset.name);
  }
  return { ok: true, updated, skipped, failed };
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
