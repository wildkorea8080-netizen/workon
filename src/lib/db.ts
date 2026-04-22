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
