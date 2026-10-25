import type { OrgType } from './org-types';

export type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { message: string; code?: string; details?: unknown } };

export type UserRole = 'ADMIN' | 'USER';
export type MessageRole = 'system' | 'user' | 'assistant' | 'agent';

export type Department = {
  id: string;
  name: string;
  slug: string;
  description?: string;
  created_at: string;
  updated_at: string;
};

export type User = {
  id: string;
  email: string;
  full_name?: string;
  role: UserRole;
  /** 개인 월 한도(원). null이면 소속 부서의 기본값을 따른다 (0024) */
  monthly_budget_krw?: number | null;
  department_id?: string;
  created_at: string;
  updated_at: string;
};

export type Agent = {
  id: string;
  department_id: string;
  name: string;
  description?: string;
  system_prompt?: string;
  config: Record<string, unknown>;
  is_active: boolean;
  category?: string;
  icon?: string;
  color?: string;
  owner_id?: string | null;
  approval_status?: string | null;
  approval_note?: string | null;
  /** 누가 볼 수 있는가(권한). category와 달리 표시가 아니라 접근을 정한다. */
  visibility?: 'organization' | 'department';
  organization_id?: string | null;
  /** 직원 화면 노출 여부. false면 관리자에게만 보이는 '노출 대기중'. */
  is_published?: boolean;
  /** 카테고리 안에서의 순서. 작을수록 앞. 동률이면 이름순. */
  display_order?: number;
  /** 직원에게 보여줄 사용 방법. 대화 시작 화면에 표시된다 (0025) */
  usage_guide?: string | null;
  /** 눌러서 입력창에 채우는 예시 입력 (0025) */
  starter_prompts?: string[] | null;
  /** chat=대화형, link=외부 링크 연결형(새 탭) */
  agent_type?: 'chat' | 'link';
  link_url?: string | null;
  /** 단계 — 권한의 근거 (0026) */
  tier: 'personal' | 'department' | 'official';
  /** 이 비서의 모델. null이면 기관 기본 모델 (0026) */
  model_id?: string | null;
  /** 켜진 능력과 설정 (0026). 정규화는 capabilities/settings.ts */
  capabilities?: Record<string, unknown>;
  /** 현재 판 번호 (0026). 저장할 때 base_version으로 돌려보낸다 */
  version: number;
  deleted_at?: string | null;
  approval_version?: number | null;
  approval_requested_by?: string | null;
  created_by?: string;
  updated_by?: string;
  created_at: string;
  updated_at: string;
};

/**
 * NODA 읽기 상태(0031). NULL = 옮기기 전 문서.
 * failed = 다시 시도 가능, unreadable = NODA가 못 읽음(다시 해도 같음), deleting = NODA 삭제 실패.
 * retired = 공통 문서(`common_documents`)만 쓴다 — 지난 판이 되어 NODA 사본을 지운 상태.
 */
export type NodaStatus = 'reading' | 'ready' | 'failed' | 'unreadable' | 'deleting' | 'retired';

export type Document = {
  id: string;
  department_id: string;
  agent_id?: string;
  uploaded_by?: string;
  storage_path: string;
  file_name: string;
  file_type?: string;
  title?: string;
  summary?: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  noda_status: NodaStatus | null;
  noda_reason: string | null;
  noda_filename: string | null;
  noda_doc_id: string | null;
  noda_read_started_at: string | null;
  noda_last_attempt_at: string | null;
  noda_read_at: string | null;
};

/** 공통 자료실 문서(S5) — 기관 유형 단위 자료. 기관·부서 칸이 없다 */
export interface CommonDocument {
  id: string;
  org_type: OrgType;
  title: string;
  edition_year: number;
  usage_terms: string;
  file_name: string;
  file_type: string | null;
  size_bytes: number | null;
  storage_path: string;
  noda_status: NodaStatus;
  noda_reason: string | null;
  noda_filename: string | null;
  noda_doc_id: string | null;
  noda_read_started_at: string | null;
  noda_last_attempt_at: string | null;
  noda_read_at: string | null;
  /** 이 문서가 대신하는 옛 판 */
  replaces_id: string | null;
  /** 지난 판이 된 때 */
  retired_at: string | null;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
}

export type Conversation = {
  id: string;
  department_id: string;
  agent_id?: string;
  user_id?: string;
  title?: string;
  status: string;
  share_token?: string | null;
  is_shared?: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type Message = {
  id: string;
  conversation_id: string;
  user_id?: string;
  role: MessageRole;
  content: string;
  source_references: Record<string, unknown>;
  created_at: string;
};

export type ReportTemplate = {
  id: string;
  department_id: string;
  created_by?: string;
  name: string;
  description?: string;
  content: string;
  schema: Record<string, unknown>;
  is_active: boolean;
  version: number;
  created_at: string;
  updated_at: string;
};

export type UsageLog = {
  id: string;
  department_id?: string;
  user_id?: string;
  action: string;
  resource_type?: string;
  resource_id?: string;
  details: Record<string, unknown>;
  created_at: string;
};

export type ForbiddenWord = {
  id: string;
  department_id: string;
  word: string;
  context?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type DocumentChunk = {
  index: number;
  text: string;
  embedding: number[];
};

export type RetrievedChunk = {
  documentId: string;
  documentTitle?: string;
  chunkIndex: number;
  /**
   * NODA 근거 묶음의 번호(`[n]`). 답변 속 `[n]`이 이 조각을 가리킨다. 받아들인 조각의 순번(`chunkIndex`)과 다를 수 있다 —
   * 이 비서의 다른 상태 문서 조각은 조용히 빠지기 때문이다. 옛 메시지에는 없다
   */
  n?: number;
  /**
   * 근거 원문. NODA 근거는 `/context`의 근거 묶음에서 그 번호의 글을 잘라 싣는다(최대 2,000자 — 오른쪽 근거 창이 보인다).
   * 2026-10-23 이전 메시지는 빈 글이다
   */
  text: string;
  similarity: number;
  /** 쪽(NODA `anchors[].page`). 엑셀·CSV는 쪽이 없어 null이고 `cellRange`를 쓴다. 옛 메시지에는 없다 */
  page?: number | null;
  /** 칸 주소(`표.csv!A3:D20`) */
  cellRange?: string | null;
  /** 절(NODA `outline`, 비면 `path`를 ` › `로 이음) */
  section?: string | null;
  /** 스캔 판독(OCR)으로 읽은 조각 — 원문과 다르게 읽혔을 수 있다 */
  ocr?: boolean;
  /** 공통 자료실 조각이면 `'common'`(비서 문서 조각은 없음). 옛 메시지에는 없다 */
  scope?: 'common';
  /** 공통 문서의 기준 연도 — 출처 칩에 `(2026)`으로 보인다 */
  editionYear?: number;
};

export type RetrievalResult = {
  query: string;
  chunks: RetrievedChunk[];
  totalChunks: number;
};
