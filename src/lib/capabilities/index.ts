// src/lib/capabilities/index.ts
import type { LlmTool } from '@/lib/llm/types';
import { docSearch } from './doc-search';
import { publicData } from './public-data';
import { image } from './image';
import { documentCapability } from './document';
import { fileRead } from './file-read';
import {
  CAPABILITY_IDS,
  normalizeCapabilities,
  clampToScope,
  type CapabilitySettings,
  type CapabilityScope,
} from './settings';
import type { Capability, TurnContext } from './types';

/**
 * 능력 목록. 능력을 더할 때는 파일 하나를 만들고 여기 올린다 —
 * 대화 실행기는 고치지 않는다(설계 4.1).
 */
export const CAPABILITIES: Capability[] = [docSearch, publicData, image, documentCapability, fileRead];

/** 켜져 있고 쓸 준비가 된 능력 */
export function activeCapabilities(settings: CapabilitySettings): Capability[] {
  return CAPABILITIES.filter((cap) => cap.id in settings && cap.isAvailable());
}

/** 이번 턴에 꺼내 줄 도구와, 도구 이름 → 맡은 능력 */
export function toolsFor(
  capabilities: Capability[],
  ctx: TurnContext
): { tools: LlmTool[]; owners: Map<string, Capability> } {
  const tools: LlmTool[] = [];
  const owners = new Map<string, Capability>();
  for (const cap of capabilities) {
    for (const tool of cap.tools?.(ctx) ?? []) {
      tools.push(tool);
      owners.set(tool.name, cap);
    }
  }
  return { tools, owners };
}

/**
 * 대화할 때 실제로 켤 능력.
 *
 * 저장된 값을 다시 정규화한다 — 키가 빠진 커넥터, 깨진 값이 있을 수 있다.
 * 깨져 있으면 아무 능력도 켜지 않는다. 실패가 권한을 넓히면 안 된다.
 * 나만의·부서 비서는 기관 범위로 자른다. 관리자가 나중에 기관에서 끈
 * 연결을 거둬들이는 길이다(설계 3.4).
 */
export function effectiveCapabilities(
  stored: unknown,
  opts: { tier: 'personal' | 'department' | 'official'; scope: CapabilityScope; knownConnectorIds: string[] }
): CapabilitySettings {
  // 키가 빠진 커넥터는 '모르는 연결'로 거절되므로, 정규화 전에 걸러 둔다
  const known = new Set(opts.knownConnectorIds);
  let input = stored;
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    const copy = { ...(stored as Record<string, unknown>) };
    // 모르는 능력은 건너뛴다. 나중 배포가 저장한 능력 때문에 이 배포의 다른 능력까지
    // 꺼지면, 되돌리기 배포 때 조용히 권한이 빠진다. 저장(normalizeCapabilities)은 여전히 거절한다.
    const ids = Object.keys(copy).filter((id) => !(CAPABILITY_IDS as readonly string[]).includes(id));
    if (ids.length > 0) {
      console.warn('[capabilities] 모르는 능력은 건너뜁니다:', ids);
      for (const id of ids) delete copy[id];
    }
    const pd = copy.public_data as { connectors?: unknown } | undefined;
    if (pd && Array.isArray(pd.connectors)) {
      copy.public_data = { connectors: pd.connectors.filter((c) => typeof c === 'string' && known.has(c)) };
    }
    input = copy;
  }

  const normalized = normalizeCapabilities(input, { knownConnectorIds: opts.knownConnectorIds });
  if (!normalized.ok) {
    console.warn('[capabilities] 저장된 능력 설정을 읽지 못해 끕니다:', normalized.message);
    return {};
  }
  return opts.tier === 'official' ? normalized.value : clampToScope(normalized.value, opts.scope);
}
