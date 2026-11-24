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

export type OrgApiScope = 'adoption' | 'usage' | 'documents' | 'documents_write' | 'documents_delete' | 'chat';
export const ORG_API_SCOPES: OrgApiScope[] = ['adoption', 'usage', 'documents', 'documents_write', 'documents_delete', 'chat'];
export const ORG_API_SCOPE_LABELS: Record<OrgApiScope, string> = {
  adoption: '도입 현황(월별·부서별)',
  usage: '이용통계(비서별·부서별)·답변 평가·앱 실행·예산',
  // (2026-11-23, 0099) 문서함 현황 — 이름·비서·읽기 상태·판·태그만, 본문·원본·저장소 경로 없음
  documents: '문서함 현황(문서 이름·비서·읽기 상태·판·태그 — 본문 없음)',
  // (2026-11-24, 0100) 문서 올리기·새 판으로 바꾸기 — 비서 문서함에 쓴다. 지우기는 API로 하지 않는다(사람이 화면에서)
  documents_write: '문서 올리기·새 판 올리기(비서 문서함에 씀 — 지우기는 따로)',
  // (2026-11-24, 0104) 문서 지우기 — 되돌릴 수 없어 올리기와 따로 고른다. 공식·부서 비서의 문서만
  documents_delete: '문서 지우기(비서 문서함에서 지움 — 되돌릴 수 없음)',
  // (2026-11-24, 0101) 비서에게 묻기 — 답 글·근거 발췌가 기관 시스템으로 나간다. 키를 만든 관리자의 대화로 남고 그 사람의 한도를 쓴다
  chat: '비서에게 묻기(답 글·근거 발췌가 밖으로 나감 — 키를 만든 관리자의 대화·한도)',
};
/** 쓰기 범위 — 화면이 고를 때 따로 경고한다 */
export const ORG_API_WRITE_SCOPES: OrgApiScope[] = ['documents_write', 'documents_delete'];
/** 글을 밖으로 내는 범위 — 화면이 고를 때 따로 경고한다(0101) */
export const ORG_API_CONTENT_SCOPES: OrgApiScope[] = ['chat'];

export type OrgApiEndpoint = 'adoption-report' | 'adoption-departments' | 'usage-summary' | 'feedback-summary' | 'app-runs' | 'budget' | 'documents'
  | 'documents-upload-url' | 'documents-create' | 'documents-delete' | 'chat' | 'chat-attachment-upload-url' | 'chat-attachment-confirm';
/** 끝점 → 필요한 범위·주소 — 화면 안내와 서버가 같은 표를 본다(method가 없으면 GET) */
export const ORG_API_ENDPOINTS: Record<OrgApiEndpoint, { scope: OrgApiScope; path: string; label: string; method?: 'POST' | 'DELETE' }> = {
  'adoption-report': { scope: 'adoption', path: '/api/v1/adoption-report?month=2026-11', label: '월별 도입 현황' },
  'adoption-departments': { scope: 'adoption', path: '/api/v1/adoption-report/departments?month=2026-11', label: '부서별 도입 현황' },
  'usage-summary': { scope: 'usage', path: '/api/v1/usage-summary?by=agent&from=2026-10-01&to=2026-10-31', label: '이용통계(by=agent|department)' },
  // (2026-11-11, 0086) 관리자 통계 화면의 숫자 셋 — 같은 읽기 함수, 질문·답변·결과 글·직원 없음
  'feedback-summary': { scope: 'usage', path: '/api/v1/feedback-summary?from=2026-10-01&to=2026-10-31', label: '답변 평가(비서별 도움됨·아쉬움·줄인 시간)' },
  'app-runs': { scope: 'usage', path: '/api/v1/app-runs', label: '입력형 앱 실행 현황(최근 30일)' },
  'budget': { scope: 'usage', path: '/api/v1/budget', label: '예산 소진 현황(기관·부서 월 한도)' },
  // (2026-11-23, 0099) 기관 문서관리시스템이 WORKON 문서함과 맞대 보는 목록 — 읽기 실패·낡은 판·근거로 쓰는지
  'documents': { scope: 'documents', path: '/api/v1/documents?status=failed&limit=100', label: '문서함 목록(읽기 상태·판·시행일·근거로 쓰는지·태그, 본문·원본 없음)' },
  // (2026-11-24, 0100) 기관 문서관리시스템이 규정을 비서 문서함에 올린다 — ① 올리기 주소 ② 그 주소에 PUT ③ 확인(읽기 시작)
  'documents-upload-url': { scope: 'documents_write', method: 'POST', path: '/api/v1/documents/upload-url', label: '문서 올리기 주소 받기(10분 안에 PUT으로 올림)' },
  'documents-create': { scope: 'documents_write', method: 'POST', path: '/api/v1/documents', label: '올린 문서 등록·읽기 시작(새 판이면 replacesId·시행일)' },
  // (2026-11-24, 0104) 폐지한 규정 내리기 — 관리자 문서 화면과 같은 길(NODA → 행 → 원본)
  'documents-delete': { scope: 'documents_delete', method: 'DELETE', path: '/api/v1/documents/{id}', label: '문서 지우기(공식·부서 비서의 문서, 되돌릴 수 없음)' },
  // (2026-11-24, 0101) 기관 시스템(민원 창구·그룹웨어 봇)이 공식·부서 비서에게 묻는다 — 대화와 같은 실행기(근거·숫자 확인·한도·금지어)
  'chat': { scope: 'chat', method: 'POST', path: '/api/v1/chat', label: '비서에게 묻기(답·근거·확인되지 않은 숫자, 이어 묻기는 conversationId, 첨부는 attachmentIds, 흐름은 stream: true)' },
  // (2026-11-24, 0105) 묻기에 붙일 파일 — ① 올리기 주소 ② PUT ③ 확인(읽기) ④ 묻기의 attachmentIds
  'chat-attachment-upload-url': { scope: 'chat', method: 'POST', path: '/api/v1/chat/attachments/upload-url', label: '묻기에 붙일 파일 올리기 주소(10분 안에 PUT·확인)' },
  'chat-attachment-confirm': { scope: 'chat', method: 'POST', path: '/api/v1/chat/attachments', label: '올린 첨부 확인·읽기(읽은 표·쪽 요약)' },
};

/**
 * API로 쓸 수 있는 비서인가(문서 올리기 0100·묻기 0101) — 이 기관의 지우지 않은 공식·부서 비서.
 * 나만의 비서는 키를 만든 사람의 것이어도 아니다(목록 API 0099가 감추는 비서와 같다)
 */
export function writableAgent<T extends { deleted_at: string | null; tier: string; organization_id: string | null }>(agent: T | null, organizationId: string): agent is T {
  return Boolean(agent && !agent.deleted_at && agent.tier !== 'personal' && agent.organization_id === organizationId);
}

// ── 비서에게 묻기(POST /api/v1/chat, 0101) ──

/** 한 번에 묻는 글의 상한 — 대화 화면 넘겨받기(chat-handoff)와 같은 4,000자 */
export const ORG_API_CHAT_MAX_CHARS = 4000;
/** 한 번에 붙이는 첨부 — 화면 대화와 같은 10개(attachments/limits.ts MAX_ATTACHMENTS_PER_SEND) */
export const ORG_API_CHAT_MAX_ATTACHMENTS = 10;
export type ChatAskInput = { agentId: string; question: string; conversationId: string | null; skipDocuments: boolean; tags: unknown; stream: boolean; attachmentIds: string[] };

/** `{ agentId, question, conversationId?, skipDocuments?, tags? }` — 태그 꼴은 대화 실행기가 화면과 같은 함수로 다시 본다 */
export function parseChatAsk(raw: unknown): { ok: true; value: ChatAskInput } | { ok: false; message: string } {
  const b = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null) as Record<string, unknown> | null;
  if (!b) return { ok: false, message: '요청 몸은 JSON 객체로 보내 주세요.' };
  if (!isUuid(b.agentId)) return { ok: false, message: 'agentId는 비서 id(uuid)로 적어 주세요.' };
  if (typeof b.question !== 'string' || !b.question.trim()) return { ok: false, message: 'question에 물을 글을 적어 주세요.' };
  const question = b.question.normalize('NFC').trim();
  if (question.length > ORG_API_CHAT_MAX_CHARS) return { ok: false, message: `question은 ${ORG_API_CHAT_MAX_CHARS.toLocaleString('en-US')}자 이내로 적어 주세요.` };
  let conversationId: string | null = null;
  if (b.conversationId !== undefined && b.conversationId !== null && b.conversationId !== '') {
    if (!isUuid(b.conversationId)) return { ok: false, message: 'conversationId는 앞 응답의 conversationId(uuid)를 그대로 넣어 주세요.' };
    conversationId = b.conversationId.toLowerCase();
  }
  // 조용히 무시하지 않는다 — 'true' 글을 받아 문서를 찾고 답하면 밖의 시스템은 문서 없이 답한 줄 안다
  if (b.skipDocuments !== undefined && b.skipDocuments !== null && typeof b.skipDocuments !== 'boolean') return { ok: false, message: 'skipDocuments는 true 또는 false로 적어 주세요.' };
  // 스트리밍(2026-11-24) — 글자 'true'를 받아 한꺼번에 답하면 밖의 시스템이 흐름을 기다리다 멈춘다
  if (b.stream !== undefined && b.stream !== null && typeof b.stream !== 'boolean') return { ok: false, message: 'stream은 true 또는 false로 적어 주세요.' };
  // 첨부(2026-11-24, 0105) — 올리기 주소 → PUT → 확인을 마친 attachmentId만. 붙일 수 있는지는 대화 실행기가 다시 본다
  let attachmentIds: string[] = [];
  if (b.attachmentIds !== undefined && b.attachmentIds !== null) {
    if (!Array.isArray(b.attachmentIds) || !b.attachmentIds.every(isUuid)) return { ok: false, message: 'attachmentIds는 첨부 확인 응답의 attachmentId(uuid) 배열로 적어 주세요.' };
    attachmentIds = [...new Set((b.attachmentIds as string[]).map((id) => id.toLowerCase()))];
    if (attachmentIds.length > ORG_API_CHAT_MAX_ATTACHMENTS) return { ok: false, message: `첨부는 한 번에 ${ORG_API_CHAT_MAX_ATTACHMENTS}개까지 붙일 수 있습니다.` };
  }
  return { ok: true, value: { agentId: b.agentId.toLowerCase(), question, conversationId, skipDocuments: b.skipDocuments === true, tags: b.tags ?? undefined, stream: b.stream === true, attachmentIds } };
}

// ── 문서 올리기(/api/v1/documents/upload-url · POST /api/v1/documents, 0100) ──

export type DocUploadUrlInput = { agentId: string; fileName: string; size: number; fileType: string };
export type DocCreateInput = {
  path: string; agentId: string; fileName: string; fileType: string; title: string | null;
  replacesId: string | null; effectiveFrom: string | null; tags: unknown; visibility: 'organization' | 'department';
};

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const cleanName = (v: unknown) => (typeof v === 'string' ? v.normalize('NFC').trim() : '');

/** 올리기 주소 요청 `{ agentId, fileName, size, fileType? }` — 비서 하나에(여러 비서는 호출을 나눔). 파일 검사는 서버의 같은 함수가 다시 한다 */
export function parseDocUploadUrl(raw: unknown): { ok: true; value: DocUploadUrlInput } | { ok: false; message: string } {
  const b = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null) as Record<string, unknown> | null;
  if (!b) return { ok: false, message: '요청 몸은 JSON 객체로 보내 주세요.' };
  if (!isUuid(b.agentId)) return { ok: false, message: 'agentId는 비서 id(uuid)로 적어 주세요.' };
  const fileName = cleanName(b.fileName);
  if (!fileName) return { ok: false, message: 'fileName에 원래 파일 이름(확장자 포함)을 적어 주세요.' };
  if (typeof b.size !== 'number' || !Number.isSafeInteger(b.size) || b.size < 1) return { ok: false, message: 'size에 파일 크기(바이트, 정수)를 적어 주세요.' };
  if (b.fileType !== undefined && b.fileType !== null && typeof b.fileType !== 'string') return { ok: false, message: 'fileType은 글로 적어 주세요(예: application/pdf).' };
  return { ok: true, value: { agentId: b.agentId.toLowerCase(), fileName, size: b.size, fileType: typeof b.fileType === 'string' ? b.fileType : '' } };
}

/** 등록 요청 `{ path, agentId, fileName, fileType?, title?, replacesId?, effectiveFrom?, tags?, visibility? }` — 날짜·태그는 서버가 화면과 같은 함수로 본다 */
export function parseDocCreate(raw: unknown): { ok: true; value: DocCreateInput } | { ok: false; message: string } {
  const b = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null) as Record<string, unknown> | null;
  if (!b) return { ok: false, message: '요청 몸은 JSON 객체로 보내 주세요.' };
  if (typeof b.path !== 'string' || !b.path) return { ok: false, message: 'path에 올리기 주소 응답의 path를 그대로 넣어 주세요.' };
  if (!isUuid(b.agentId)) return { ok: false, message: 'agentId는 비서 id(uuid)로 적어 주세요.' };
  const fileName = cleanName(b.fileName);
  if (!fileName) return { ok: false, message: 'fileName에 원래 파일 이름(확장자 포함)을 적어 주세요.' };
  if (b.fileType !== undefined && b.fileType !== null && typeof b.fileType !== 'string') return { ok: false, message: 'fileType은 글로 적어 주세요(예: application/pdf).' };
  if (b.title !== undefined && b.title !== null && typeof b.title !== 'string') return { ok: false, message: 'title은 글로 적어 주세요.' };
  const title = typeof b.title === 'string' ? b.title.normalize('NFC').replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim() : '';
  if (title.length > 200) return { ok: false, message: 'title은 200자 이내로 적어 주세요.' };
  let replacesId: string | null = null;
  if (b.replacesId !== undefined && b.replacesId !== null && b.replacesId !== '') {
    if (!isUuid(b.replacesId)) return { ok: false, message: 'replacesId는 바꿀 옛 판의 문서 id(uuid)로 적어 주세요.' };
    replacesId = b.replacesId.toLowerCase();
  }
  if (b.effectiveFrom !== undefined && b.effectiveFrom !== null && typeof b.effectiveFrom !== 'string') return { ok: false, message: 'effectiveFrom은 2026-01-01처럼 날짜로 적어 주세요.' };
  if (b.visibility !== undefined && b.visibility !== null && b.visibility !== 'organization' && b.visibility !== 'department') {
    return { ok: false, message: 'visibility는 organization 또는 department로 적어 주세요.' };
  }
  return {
    ok: true,
    value: {
      path: b.path, agentId: b.agentId.toLowerCase(), fileName, fileType: typeof b.fileType === 'string' ? b.fileType : '',
      title: title || null, replacesId, effectiveFrom: typeof b.effectiveFrom === 'string' && b.effectiveFrom ? b.effectiveFrom : null,
      tags: b.tags, visibility: b.visibility === 'department' ? 'department' : 'organization',
    },
  };
}

// ── 문서함 목록(/api/v1/documents, 0099) ──

/** 문서 읽기 상태 — `documents.noda_status`를 밖에 보일 이름으로(NULL = NODA로 옮기기 전 옛 문서) */
export type OrgApiDocStatus = 'legacy' | 'reading' | 'ready' | 'failed' | 'unreadable' | 'deleting' | 'retired';
export const ORG_API_DOC_STATUSES: OrgApiDocStatus[] = ['legacy', 'reading', 'ready', 'failed', 'unreadable', 'deleting', 'retired'];
export const ORG_API_DOCS_DEFAULT_LIMIT = 100;
export const ORG_API_DOCS_MAX_LIMIT = 200;

export function docStatusOf(nodaStatus: string | null | undefined): OrgApiDocStatus {
  if (nodaStatus == null) return 'legacy';
  return (ORG_API_DOC_STATUSES as string[]).includes(nodaStatus) && nodaStatus !== 'legacy' ? (nodaStatus as OrgApiDocStatus) : 'legacy';
}

export type DocListQuery = { status: OrgApiDocStatus | null; agentId: string | null; cursor: string | null; limit: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `?status=&agent=&cursor=&limit=` 검사 — 틀리면 400 글(조용히 기본값으로 바꾸지 않는다: 밖의 시스템이 틀린 거르기를 모르고 전체를 받게 된다) */
export function parseDocListQuery(params: { status: string | null; agent: string | null; cursor: string | null; limit: string | null }): { ok: true; value: DocListQuery } | { ok: false; message: string } {
  let status: OrgApiDocStatus | null = null;
  if (params.status != null && params.status !== '') {
    if (!(ORG_API_DOC_STATUSES as string[]).includes(params.status)) return { ok: false, message: `status는 ${ORG_API_DOC_STATUSES.join('·')} 중 하나로 적어 주세요.` };
    status = params.status as OrgApiDocStatus;
  }
  let agentId: string | null = null;
  if (params.agent != null && params.agent !== '') {
    if (!UUID.test(params.agent)) return { ok: false, message: 'agent는 비서 id(uuid)로 적어 주세요.' };
    agentId = params.agent.toLowerCase();
  }
  let limit = ORG_API_DOCS_DEFAULT_LIMIT;
  if (params.limit != null && params.limit !== '') {
    if (!/^\d{1,4}$/.test(params.limit) || Number(params.limit) < 1 || Number(params.limit) > ORG_API_DOCS_MAX_LIMIT) return { ok: false, message: `limit은 1~${ORG_API_DOCS_MAX_LIMIT} 사이 정수로 적어 주세요.` };
    limit = Number(params.limit);
  }
  const cursor = params.cursor != null && params.cursor !== '' ? params.cursor : null;
  return { ok: true, value: { status, agentId, cursor, limit } };
}

/** 밖으로 내는 문서 한 줄 — 본문·요약·원본 경로·NODA 파일 이름·올린 사람은 싣지 않는다 */
export interface OrgApiDocument {
  id: string;
  title: string;
  fileName: string;
  fileType: string | null;
  agent: { id: string; name: string } | null;
  departmentId: string | null;
  departmentName: string | null;
  status: OrgApiDocStatus;
  /** 읽지 못했거나 실패한 까닭(있을 때만) */
  reason: string | null;
  /** 지금 대화에서 근거로 쓰는가 — 읽힘이고, 시행 중인 새 판이 대신하지 않고, 시행일 전인 새 판이 아님 */
  citable: boolean;
  tags: string[];
  edition: { replacesId: string | null; replacedById: string | null; effectiveFrom: string | null; retiredAt: string | null };
  createdAt: string;
  readAt: string | null;
}

export const ORG_API_INVALID_TOKEN = 'API 키가 올바르지 않거나 회수·만료됐습니다.';
export const ORG_API_DAILY_LIMITED = `이 키의 오늘 호출 수(${ORG_API_DAILY_LIMIT}번)를 다 썼습니다. 내일(한국 시간) 다시 호출해 주세요.`;
export const ORG_API_SCOPE_DENIED = '이 API 키로는 읽을 수 없는 자료입니다(키의 범위 밖).';
export const ORG_API_CREATOR_UNAVAILABLE = '이 키를 만든 관리자가 더 이상 기관 전체 관리자가 아니어서 쓸 수 없습니다. 새 키를 만들어 주세요.';
export const ORG_API_IP_DENIED = '기관의 접속 허용 IP 밖에서 호출했습니다.';
/** 정지·종료한 기관(2026-11-19) — 대화·문서 올리기처럼 통계 API도 멈춘다 */
export const ORG_API_ORG_STOPPED = '기관 이용이 정지되었거나 종료되어 통계 API를 쓸 수 없습니다.';
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
