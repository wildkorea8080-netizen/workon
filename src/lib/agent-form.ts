import type { Agent } from '@/lib/db';

/**
 * 비서 편집 화면의 순수 계산. 화면 코드에 흩어 두면 관리자 화면과 직원
 * 화면이 다른 규칙을 갖게 된다(예전에 아이콘·카테고리가 직원 폼에만 있었다).
 */

export interface AgentSettingsValue {
  name: string;
  description: string;
  icon: string;
  category: string;
  usage_guide: string;
  /** 한 줄에 하나. 서버가 나눈다 */
  starter_prompts: string;
  system_prompt: string;
  /** '' = 기관 기본 모델 */
  model_id: string;
  doc_search: boolean;
  image: boolean;
  document: boolean;
  file_read: boolean;
  connectors: string[];
}

export const TIER_LABELS = {
  personal: '나만의 비서',
  department: '부서 비서',
  official: '공식 비서',
} as const;

const FIELD_LABELS: Record<string, string> = {
  name: '이름',
  description: '설명',
  icon: '아이콘',
  color: '색',
  category: '카테고리',
  usage_guide: '사용 방법',
  starter_prompts: '시작 예시',
  system_prompt: '지시문',
  model_id: '모델',
  capabilities: '능력',
  template_ids: '양식',
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function connectorIdsOf(capabilities: unknown): string[] {
  if (!isObject(capabilities) || !isObject(capabilities.public_data)) return [];
  const list = capabilities.public_data.connectors;
  return Array.isArray(list) ? list.filter((c): c is string => typeof c === 'string') : [];
}

export function settingsFromAgent(
  agent: Pick<Agent, 'name' | 'description' | 'icon' | 'category' | 'usage_guide' | 'starter_prompts' | 'system_prompt' | 'model_id' | 'capabilities'>
): AgentSettingsValue {
  const caps = isObject(agent.capabilities) ? agent.capabilities : {};
  return {
    name: agent.name,
    description: agent.description ?? '',
    icon: agent.icon ?? '',
    category: agent.category ?? '',
    usage_guide: agent.usage_guide ?? '',
    starter_prompts: (agent.starter_prompts ?? []).join('\n'),
    system_prompt: agent.system_prompt ?? '',
    model_id: agent.model_id ?? '',
    doc_search: 'doc_search' in caps,
    image: 'image' in caps,
    document: 'document' in caps,
    file_read: 'file_read' in caps,
    connectors: connectorIdsOf(caps),
  };
}

export function settingsToBody(value: AgentSettingsValue, opts: { isLink: boolean }): Record<string, unknown> {
  const display = {
    name: value.name.trim(),
    description: value.description.trim() || null,
    icon: value.icon.trim() || null,
    category: value.category.trim() || null,
  };
  if (opts.isLink) return display;

  return {
    ...display,
    usage_guide: value.usage_guide.trim() || null,
    starter_prompts: value.starter_prompts,
    system_prompt: value.system_prompt.trim() || null,
    model_id: value.model_id || null,
    capabilities: {
      ...(value.doc_search ? { doc_search: {} } : {}),
      ...(value.image ? { image: {} } : {}),
      ...(value.document ? { document: {} } : {}),
      // 저장 값에서 읽어 그대로 돌려보낸다 — 빠뜨리면 다른 칸을 저장할 때 조용히 꺼진다
      ...(value.file_read ? { file_read: {} } : {}),
      ...(value.connectors.length > 0 ? { public_data: { connectors: value.connectors } } : {}),
    },
  };
}

export interface HistoryItemLike {
  kind: string;
  version: number | null;
  detail: Record<string, unknown>;
}

export function describeHistoryItem(item: HistoryItemLike): string {
  const d = item.detail ?? {};
  switch (item.kind) {
    case 'created':
      return '만듦';
    case 'migrated':
      return '단계 도입 이전의 내용';
    case 'preset_update':
      return '기본 비서 내용 갱신';
    case 'revert':
      return `판 ${String(d.reverted_from)}로 되돌림`;
    case 'tier': {
      const from = TIER_LABELS[d.from as keyof typeof TIER_LABELS] ?? String(d.from);
      const to = TIER_LABELS[d.to as keyof typeof TIER_LABELS] ?? String(d.to);
      return `${from} → ${to}`;
    }
    case 'document_added':
      return `문서 '${String(d.file_name)}'을(를) 올림`;
    case 'document_removed':
      return `문서 '${String(d.file_name)}'을(를) 지움`;
    case 'deleted':
      return '지움';
    case 'settings': {
      if (d.reason === 'auto_enable') return '문서를 올려 참고 문서 찾기를 켬';
      if (typeof d.template_added === 'string') return `양식 '${d.template_added}'을(를) 추가함`;
      if (typeof d.template_removed === 'string') return `양식 '${d.template_removed}'을(를) 뺌`;
      const fields = Array.isArray(d.fields) ? (d.fields as string[]) : [];
      if (fields.length === 0) return '설정을 저장함';
      return `${fields.map((f) => FIELD_LABELS[f] ?? f).join('·')}을 바꿈`;
    }
    default:
      return item.kind;
  }
}

export function canRevertTo(item: HistoryItemLike, currentVersion: number): boolean {
  return item.version !== null && item.version !== currentVersion;
}

export interface ConnectorChoice {
  id: string;
  label: string;
  allowedForPersonal?: boolean;
}

/**
 * 편집 창에 내놓을 연결. 나만의·부서 비서는 기관이 공식 비서에서 쓰는 것만.
 * 이미 켜 둔 것은 기관이 그 뒤 껐더라도 목록에 남겨 끌 수 있게 한다.
 */
export function connectorChoices(
  all: ConnectorChoice[],
  tier: 'personal' | 'department' | 'official',
  current: string[]
): ConnectorChoice[] {
  if (tier === 'official') return all;
  return all.filter((c) => c.allowedForPersonal || current.includes(c.id));
}

/**
 * 켜져 있지만 기관이 쓰지 않는 연결인가. connectorChoices가 '이미 켜 둔 것'이라
 * 남겨 둔 연결이 여기에 걸린다. 이 연결이 켜져 있으면 서버가 저장을 403으로
 * 거절하므로, 화면이 끄라고 알려야 한다.
 */
export function isConnectorOutOfScope(
  choice: ConnectorChoice,
  tier: 'personal' | 'department' | 'official'
): boolean {
  if (tier === 'official') return false;
  return !choice.allowedForPersonal;
}

/** 서버에서 마지막으로 읽은 설정(JSON)과 지금 화면 값이 다른가. 기준이 없으면 '수정 없음' */
export function isSettingsDirty(value: AgentSettingsValue, baseline: string | null): boolean {
  if (baseline === null) return false;
  return JSON.stringify(value) !== baseline;
}

/**
 * 나만의·부서 비서 만들기 창의 능력. 사진 읽기는 늘 켠다(첨부해야 쓰이므로).
 * 대화 중 파일 받기(file_read)는 창에서 고른다 — 예전에는 만들기 창에 칸이 없어
 * 만든 뒤 편집 창을 다시 열어야 켤 수 있었다.
 */
export function createCapabilities(opts: { fileRead: boolean; connectors: string[] }): Record<string, unknown> {
  return {
    image: {},
    ...(opts.fileRead ? { file_read: {} } : {}),
    ...(opts.connectors.length > 0 ? { public_data: { connectors: opts.connectors } } : {}),
  };
}
