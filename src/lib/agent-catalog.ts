/**
 * 비서 카탈로그 필드 검증 (0019).
 *
 * 아이콘 / 카테고리 / 노출 여부 / 정렬 순서 / 링크형 비서를 다룬다.
 * 생성(POST)과 수정(PATCH) 양쪽이 같은 규칙을 써야 해서 한 곳에 모은다.
 * 특히 링크형 제약은 두 곳에 따로 쓰면 한쪽만 고치는 사고가 난다.
 *
 * 공개 범위(visibility)는 여기서 다루지 않는다 — 그건 권한이고
 * 이 파일은 표시에 관한 것이다.
 */

export type AgentType = 'chat' | 'link';

/** 이모지 하나를 상정한다. 길면 목록에서 줄이 깨진다. */
const MAX_ICON_LENGTH = 8;
const MAX_CATEGORY_LENGTH = 30;
const MAX_USAGE_GUIDE_LENGTH = 500;
/** 화면에 칩으로 늘어놓는다. 많으면 오히려 고르기 어렵다. */
const MAX_STARTERS = 6;
const MAX_STARTER_LENGTH = 120;

export interface CatalogPayload {
  icon?: string | null;
  category?: string | null;
  is_published?: boolean;
  display_order?: number;
  agent_type?: AgentType;
  link_url?: string | null;
  /** 직원에게 보여줄 사용 방법 (0025) */
  usage_guide?: string | null;
  /** 눌러서 입력창에 채우는 예시 입력 (0025) */
  starter_prompts?: string[] | null;
}

export interface CatalogParseResult {
  payload: CatalogPayload;
  error?: string;
}

function trimOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

/**
 * 링크형 비서의 주소를 검증한다.
 *
 * http/https만 허용한다. javascript: 는 클릭 시 스크립트가 실행되고,
 * data: 는 임의의 문서를 띄울 수 있어 관리자 계정이 하나만 뚫려도
 * 전 직원 화면에 그대로 노출된다.
 */
function normalizeLinkUrl(value: unknown): { url: string } | { error: string } {
  const raw = trimOrNull(value);
  if (!raw) return { error: '링크형 비서는 연결할 주소가 필요합니다.' };

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: '주소 형식이 올바르지 않습니다. (예: https://gw.example.go.kr)' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'http 또는 https 주소만 등록할 수 있습니다.' };
  }

  return { url: parsed.toString() };
}

/**
 * 요청 본문에서 카탈로그 필드를 뽑아 검증한다.
 *
 * `currentType`은 수정 시 유형을 바꾸지 않았을 때 무엇과 짝지어 검사할지
 * 판단하는 데 쓴다. 예를 들어 링크형 비서의 이름만 바꾸는 요청에는
 * agent_type이 실려 오지 않으므로, 현재 값을 알아야 link_url을 지우려는
 * 시도인지 그냥 손대지 않은 것인지 구분할 수 있다.
 */
export function parseCatalogFields(
  body: Record<string, unknown>,
  currentType: AgentType = 'chat'
): CatalogParseResult {
  const payload: CatalogPayload = {};

  if (body.icon !== undefined) {
    const icon = trimOrNull(body.icon);
    if (icon && icon.length > MAX_ICON_LENGTH) {
      return { payload, error: '아이콘은 이모지 한 자로 입력해주세요.' };
    }
    payload.icon = icon;
  }

  if (body.category !== undefined) {
    const category = trimOrNull(body.category);
    if (category && category.length > MAX_CATEGORY_LENGTH) {
      return { payload, error: `카테고리는 ${MAX_CATEGORY_LENGTH}자 이내로 입력해주세요.` };
    }
    payload.category = category;
  }

  if (body.is_published !== undefined) {
    payload.is_published = Boolean(body.is_published);
  }

  if (body.display_order !== undefined) {
    const order = Number(body.display_order);
    if (!Number.isFinite(order)) {
      return { payload, error: '정렬 순서는 숫자여야 합니다.' };
    }
    payload.display_order = Math.trunc(order);
  }

  // ── 사용 방법 · 대화 시작 예시 (0025) ──
  // 라우트마다 따로 파싱하지 않는다. 생성과 수정이 다른 규칙을 갖게 되면
  // "만들 때는 들어갔는데 고치면 사라진다" 같은 상태가 된다.
  if (body.usage_guide !== undefined) {
    const guide = trimOrNull(body.usage_guide);
    if (guide && guide.length > MAX_USAGE_GUIDE_LENGTH) {
      return { payload, error: `사용 방법은 ${MAX_USAGE_GUIDE_LENGTH}자 이내로 입력해주세요.` };
    }
    payload.usage_guide = guide;
  }

  if (body.starter_prompts !== undefined) {
    // 화면은 줄바꿈으로 구분해 보내고, API를 직접 부르면 배열로 올 수 있다.
    const raw = Array.isArray(body.starter_prompts)
      ? body.starter_prompts
      : String(body.starter_prompts ?? '').split('\n');

    const items = raw
      .map((v) => String(v ?? '').trim())
      .filter(Boolean);

    if (items.some((v) => v.length > MAX_STARTER_LENGTH)) {
      return { payload, error: `예시는 하나에 ${MAX_STARTER_LENGTH}자 이내로 입력해주세요.` };
    }
    if (items.length > MAX_STARTERS) {
      return { payload, error: `예시는 최대 ${MAX_STARTERS}개까지 넣을 수 있습니다.` };
    }

    // 빈 배열은 NULL로. 빈 배열을 저장하면 "안 정함"과 구분되지 않는다.
    payload.starter_prompts = items.length > 0 ? items : null;
  }

  // ── 유형과 주소는 짝으로 움직인다 ──
  // DB에도 CHECK 제약이 있지만, 여기서 걸러야 사용자가 읽을 수 있는
  // 한국어 오류를 받는다. 제약에만 맡기면 23514 코드만 올라온다.
  const nextType: AgentType | undefined =
    body.agent_type === 'chat' || body.agent_type === 'link' ? body.agent_type : undefined;

  if (body.agent_type !== undefined && nextType === undefined) {
    return { payload, error: "비서 유형은 'chat' 또는 'link'만 가능합니다." };
  }

  const effectiveType = nextType ?? currentType;

  if (nextType !== undefined) payload.agent_type = nextType;

  if (effectiveType === 'link') {
    // 링크형으로 바꾸는 요청인데 주소가 안 왔다면, 기존 값이 있는 경우에만
    // 통과시킨다(유형 유지 + 다른 필드만 수정하는 흐름).
    if (body.link_url === undefined && nextType === undefined) {
      return { payload };
    }
    const result = normalizeLinkUrl(body.link_url);
    if ('error' in result) return { payload, error: result.error };
    payload.link_url = result.url;
  } else if (nextType === 'chat') {
    // 대화형으로 되돌리면 주소를 반드시 비운다. 남겨두면 유형만 다시
    // 바꿨을 때 예전 주소가 되살아난다.
    payload.link_url = null;
  }

  return { payload };
}
