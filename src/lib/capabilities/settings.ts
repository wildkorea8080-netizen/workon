/**
 * 능력 설정 — 어떤 능력이 있고, 설정이 어떤 꼴이어야 하며, 기관이 어디까지
 * 열어 두었는가. DB를 보지 않는 순수 함수만 둔다.
 *
 * 능력의 실행(도구·prepare)은 S1-b의 능력 목록(`./index.ts`)이 맡는다.
 * 그 목록의 id가 여기 CAPABILITY_IDS와 같은지 테스트가 확인한다.
 */

export const CAPABILITY_IDS = ['doc_search', 'public_data', 'image'] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export interface CapabilitySettings {
  doc_search?: Record<string, never>;
  image?: Record<string, never>;
  public_data?: { connectors: string[] };
}

export type NormalizeResult = { ok: true; value: CapabilitySettings } | { ok: false; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeCapabilities(
  raw: unknown,
  opts: { knownConnectorIds: string[] }
): NormalizeResult {
  if (raw === null || raw === undefined) return { ok: true, value: {} };
  if (!isPlainObject(raw)) return { ok: false, message: '능력 설정 형식이 올바르지 않습니다.' };

  const value: CapabilitySettings = {};
  const known = new Set(opts.knownConnectorIds);

  for (const [id, settings] of Object.entries(raw)) {
    if (!(CAPABILITY_IDS as readonly string[]).includes(id)) {
      return { ok: false, message: `알 수 없는 능력입니다: ${id}` };
    }
    if (!isPlainObject(settings)) {
      return { ok: false, message: `능력 설정 형식이 올바르지 않습니다: ${id}` };
    }

    if (id === 'public_data') {
      const connectors = settings.connectors;
      if (!Array.isArray(connectors) || connectors.some((c) => typeof c !== 'string')) {
        return { ok: false, message: '공공데이터 연결 목록 형식이 올바르지 않습니다.' };
      }
      const unknown = connectors.filter((c) => !known.has(c));
      if (unknown.length > 0) {
        return { ok: false, message: `쓸 수 없는 공공데이터 연결입니다: ${unknown.join(', ')}` };
      }
      const unique = [...new Set(connectors as string[])];
      // 연결이 하나도 없는 공공데이터 능력은 켜 둔 의미가 없다
      if (unique.length > 0) value.public_data = { connectors: unique };
    } else {
      // 설정이 없는 능력. 딸려 온 값은 버린다.
      value[id as 'doc_search' | 'image'] = {};
    }
  }

  return { ok: true, value };
}

/**
 * 대화 화면에서 사진 첨부 버튼을 낼지. 저장된 값을 그대로 받는다.
 *
 * 표시일 뿐이다 — 실제로 거절하는 곳은 서버(prepare.ts의 acceptsImages)다.
 * 값이 깨져 있으면 내지 않는다. 서버도 깨진 설정이면 아무 능력도 켜지 않는다.
 */
export function acceptsChatImages(raw: unknown): boolean {
  return isPlainObject(raw) && isPlainObject(raw.image);
}

/**
 * 나만의·부서 비서가 켤 수 있는 범위.
 *
 * '기관이 공식 비서에서 이미 쓰고 있는가'로 정한다(connector-scope.ts의
 * 원래 설계). 별도 허용 목록을 두면 관리자가 같은 결정을 두 곳에서 하게 된다.
 *
 * 범위 검사는 public_data에만 건다. 문서 찾기는 자기 비서에 올린 문서를,
 * 사진 읽기는 자기가 첨부한 사진을 쓸 뿐이라 기관 밖으로 나가지 않는다.
 * 이 둘까지 묶으면 지금 문서를 올려 쓰는 나만의 비서가 막힌다.
 */
export interface CapabilityScope {
  publicDataConnectors: Set<string>;
}

export function deriveCapabilityScope(
  rows: { capabilities: unknown }[],
  knownConnectorIds: string[]
): CapabilityScope {
  const known = new Set(knownConnectorIds);
  const publicDataConnectors = new Set<string>();

  for (const row of rows) {
    const caps = isPlainObject(row.capabilities) ? row.capabilities : {};
    const pd = isPlainObject(caps.public_data) ? caps.public_data : null;
    const connectors = Array.isArray(pd?.connectors) ? pd.connectors : [];
    for (const id of connectors) {
      // 키가 빠져 목록에서 사라진 커넥터가 저장돼 있을 수 있다
      if (typeof id === 'string' && known.has(id)) publicDataConnectors.add(id);
    }
  }

  return { publicDataConnectors };
}

/** 범위 밖인 것. 저장할 때 거절 사유로 쓴다. */
export function scopeViolations(caps: CapabilitySettings, scope: CapabilityScope): string[] {
  return (caps.public_data?.connectors ?? []).filter((id) => !scope.publicDataConnectors.has(id));
}

/**
 * 범위 밖을 걷어낸 설정. 대화할 때 쓴다 — 관리자가 나중에 기관에서 끈
 * 연결을 기존 나만의·부서 비서에서도 거둬들이는 길이다.
 */
export function clampToScope(caps: CapabilitySettings, scope: CapabilityScope): CapabilitySettings {
  const result: CapabilitySettings = { ...caps };
  if (caps.public_data) {
    const kept = caps.public_data.connectors.filter((id) => scope.publicDataConnectors.has(id));
    if (kept.length > 0) result.public_data = { connectors: kept };
    else delete result.public_data;
  }
  return result;
}
