// src/lib/org-api/spec.ts
// 기관 통계 읽기 API(0075, 2026-11-09)의 순수 규칙 — 화면과 서버가 함께 쓴다(아무것도 import하지 않는다).
//
// 기관 전체 관리자가 범위를 정해 API 키를 만들면 기관의 다른 시스템이 `GET /api/v1/…`(Bearer)으로 **숫자만** 읽는다.
// 직원 이름·질문 원문·결과 글은 어느 끝점에도 없다(직원별 이용통계는 API로 내지 않는다).

export const ORG_API_TOKEN_PREFIX = 'wo_api_';
/** 화면에 남기는 키 앞부분 길이(접두 포함) — 어느 키인지 알아보는 데만 */
export const ORG_API_SHOWN_PREFIX_CHARS = 12;
/** 기관 하나가 둘 수 있는 쓸 수 있는(회수·만료 안 된) 키 수 */
export const ORG_API_MAX_ACTIVE_KEYS = 10;
/** 키 하나의 하루(한국 날짜) 호출 상한 */
export const ORG_API_DAILY_LIMIT = 1000;
/** 고를 수 있는 유효 기간(일). 무기한 키는 만들지 않는다 */
export const ORG_API_EXPIRY_DAYS = [30, 90, 365] as const;
export const ORG_API_NAME_MAX = 40;
/** 이용통계 한 번에 볼 수 있는 기간(일) */
export const ORG_API_USAGE_MAX_DAYS = 366;

export type OrgApiScope = 'adoption' | 'usage';
export const ORG_API_SCOPES: OrgApiScope[] = ['adoption', 'usage'];
export const ORG_API_SCOPE_LABELS: Record<OrgApiScope, string> = {
  adoption: '도입 현황(월별·부서별)',
  usage: '이용통계(비서별·부서별)·답변 평가·앱 실행·예산',
};

export type OrgApiEndpoint = 'adoption-report' | 'adoption-departments' | 'usage-summary' | 'feedback-summary' | 'app-runs' | 'budget';
/** 끝점 → 필요한 범위·주소 — 화면 안내와 서버가 같은 표를 본다 */
export const ORG_API_ENDPOINTS: Record<OrgApiEndpoint, { scope: OrgApiScope; path: string; label: string }> = {
  'adoption-report': { scope: 'adoption', path: '/api/v1/adoption-report?month=2026-11', label: '월별 도입 현황' },
  'adoption-departments': { scope: 'adoption', path: '/api/v1/adoption-report/departments?month=2026-11', label: '부서별 도입 현황' },
  'usage-summary': { scope: 'usage', path: '/api/v1/usage-summary?by=agent&from=2026-10-01&to=2026-10-31', label: '이용통계(by=agent|department)' },
  // (2026-11-11, 0086) 관리자 통계 화면의 숫자 셋 — 같은 읽기 함수, 질문·답변·결과 글·직원 없음
  'feedback-summary': { scope: 'usage', path: '/api/v1/feedback-summary?from=2026-10-01&to=2026-10-31', label: '답변 평가(비서별 도움됨·아쉬움·줄인 시간)' },
  'app-runs': { scope: 'usage', path: '/api/v1/app-runs', label: '입력형 앱 실행 현황(최근 30일)' },
  'budget': { scope: 'usage', path: '/api/v1/budget', label: '예산 소진 현황(기관·부서 월 한도)' },
};

export const ORG_API_INVALID_TOKEN = 'API 키가 올바르지 않거나 회수·만료됐습니다.';
export const ORG_API_DAILY_LIMITED = `이 키의 오늘 호출 수(${ORG_API_DAILY_LIMIT}번)를 다 썼습니다. 내일(한국 시간) 다시 호출해 주세요.`;
export const ORG_API_SCOPE_DENIED = '이 API 키로는 읽을 수 없는 자료입니다(키의 범위 밖).';
export const ORG_API_CREATOR_UNAVAILABLE = '이 키를 만든 관리자가 더 이상 기관 전체 관리자가 아니어서 쓸 수 없습니다. 새 키를 만들어 주세요.';
export const ORG_API_IP_DENIED = '기관의 접속 허용 IP 밖에서 호출했습니다.';
export const ORG_API_WHOLE_ORG_ONLY = '기관 통계 API 키는 기관 전체 관리자(최상위 부서 소속 관리자)만 다룹니다.';

/** `Authorization: Bearer wo_api_…`에서 키를 꺼낸다(꼴이 아니면 null) */
export function bearerOrgApiToken(header: string | null | undefined): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  const token = m?.[1] ?? '';
  return token.startsWith(ORG_API_TOKEN_PREFIX) && token.length >= 20 && token.length <= 200 ? token : null;
}

export type CreateKeyInput = { name: string; scopes: OrgApiScope[]; days: (typeof ORG_API_EXPIRY_DAYS)[number] };

/** 키 만들기 요청 검사 — 이름(다듬어 1~40자, 제어·서식 글자 뺌)·범위(하나 이상, 중복 없이 정해 둔 순서로)·유효 기간 */
export function parseCreateKey(raw: unknown): { ok: true; value: CreateKeyInput } | { ok: false; message: string } {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.normalize('NFC').replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim() : '';
  if (!name) return { ok: false, message: '키 이름을 적어 주세요(예: 경영정보 대시보드).' };
  if (name.length > ORG_API_NAME_MAX) return { ok: false, message: `키 이름은 ${ORG_API_NAME_MAX}자 이내로 적어 주세요.` };
  const given = Array.isArray(body.scopes) ? body.scopes : [];
  if (given.some((s) => !ORG_API_SCOPES.includes(s as OrgApiScope))) return { ok: false, message: '읽을 범위가 올바르지 않습니다.' };
  const scopes = ORG_API_SCOPES.filter((s) => given.includes(s));
  if (!scopes.length) return { ok: false, message: '읽을 범위를 하나 이상 고르세요.' };
  const days = Number(body.days);
  if (!(ORG_API_EXPIRY_DAYS as readonly number[]).includes(days)) return { ok: false, message: `유효 기간은 ${ORG_API_EXPIRY_DAYS.join('·')}일 중에서 고르세요.` };
  return { ok: true, value: { name, scopes, days: days as CreateKeyInput['days'] } };
}

/** 이용통계 기간(`from`·`to` = YYYY-MM-DD, 한국 날짜) — 비우면 최근 30일. 끝 날은 그날 끝까지 */
export function parseUsagePeriod(from: string | null, to: string | null, todayKst: string): { ok: true; from: string; to: string } | { ok: false; message: string } {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const valid = (d: string) => day.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
  const end = to ?? todayKst;
  if (!valid(end)) return { ok: false, message: 'to는 2026-11-09처럼 적어 주세요.' };
  const start = from ?? new Date(Date.parse(`${end}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
  if (!valid(start)) return { ok: false, message: 'from은 2026-10-01처럼 적어 주세요.' };
  if (start > end) return { ok: false, message: 'from이 to보다 늦습니다.' };
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > ORG_API_USAGE_MAX_DAYS) return { ok: false, message: `이용통계는 한 번에 ${ORG_API_USAGE_MAX_DAYS}일까지 봅니다.` };
  return { ok: true, from: start, to: end };
}

/** 화면에 보이는 키 한 줄 — 해시는 싣지 않는다 */
export interface OrgApiKeyView {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: OrgApiScope[];
  status: 'active' | 'revoked' | 'expired';
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  useCount: number;
  createdAt: string;
  createdByName: string | null;
}

export interface OrgApiCallView {
  keyId: string;
  keyName: string;
  endpoint: OrgApiEndpoint;
  httpStatus: number;
  createdAt: string;
}

/** 행 → 화면 꼴(만료는 시각으로 가른다) */
export function keyView(row: {
  id: string; name: string; token_prefix: string; scopes: string[]; status: string; expires_at: string; revoked_at: string | null;
  last_used_at: string | null; use_count: number; created_at: string;
}, nowMs: number, createdByName: string | null = null): OrgApiKeyView {
  const status = row.status === 'revoked' ? 'revoked' : Date.parse(row.expires_at) <= nowMs ? 'expired' : 'active';
  return {
    id: row.id, name: row.name, tokenPrefix: row.token_prefix, scopes: ORG_API_SCOPES.filter((s) => row.scopes.includes(s)), status,
    expiresAt: row.expires_at, revokedAt: row.revoked_at, lastUsedAt: row.last_used_at, useCount: row.use_count, createdAt: row.created_at, createdByName,
  };
}
