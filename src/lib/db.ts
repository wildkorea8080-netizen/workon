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
  is_personal: boolean;
  owner_id?: string | null;
  approval_status?: string | null;
  approval_note?: string | null;
  /** 이 에이전트가 쓸 외부 도구 커넥터 id 목록. 빈 배열이면 도구 미사용. */
  enabled_connectors?: string[];
  /** 누가 볼 수 있는가(권한). category와 달리 표시가 아니라 접근을 정한다. */
  visibility?: 'organization' | 'department';
  organization_id?: string | null;
  /** 직원 화면 노출 여부. false면 관리자에게만 보이는 '노출 대기중'. */
  is_published?: boolean;
  /** 카테고리 안에서의 순서. 작을수록 앞. 동률이면 이름순. */
  display_order?: number;
  /** chat=대화형, link=외부 링크 연결형(새 탭) */
  agent_type?: 'chat' | 'link';
  link_url?: string | null;
  created_by?: string;
  updated_by?: string;
  created_at: string;
  updated_at: string;
};

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
};

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
  text: string;
  similarity: number;
};

export type RetrievalResult = {
  query: string;
  chunks: RetrievedChunk[];
  totalChunks: number;
};
