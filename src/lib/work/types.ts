// src/lib/work/types.ts
/**
 * 업무 작업 도메인 타입 (WORKON 개편 — docs/workon-rebuild/contracts/domain.ts를 실제 구현에 맞춘 것).
 * 기관·사용자·저장 경로는 서버가 정한 값이다 — 클라이언트나 모델이 준 값을 그대로 믿지 않는다.
 *
 * 계약 초안과 다른 점(ADR 0001):
 *  - 필드 값은 text·paragraph 모두 글 하나(string)다. 여러 문단은 줄바꿈으로 나눈다 — 채우기 엔진(doc-fill)이 그 꼴을 받는다
 *  - table·image 필드는 아직 없다(D3 — 검증된 양식이 없다). 없는 기능을 타입으로 약속하지 않는다
 */

export const WORKFLOW_KEYS = [
  'intake',
  'official-letter',
  'report',
  'collection',
  'settlement',
  'regulations',
  'meeting',
  'reply',
  'audit-response',
  'handover',
] as const;
export type WorkflowKey = (typeof WORKFLOW_KEYS)[number];

export type TaskStatus = 'draft' | 'ready' | 'processing' | 'needs_review' | 'approved' | 'completed' | 'archived';
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'superseded';
export type RunOperation = 'generate' | 'revise' | 'validate' | 'render' | 'package';
export type MemberRole = 'viewer' | 'editor' | 'reviewer';
export type ArtifactFormat = 'hwpx' | 'xlsx' | 'pdf' | 'zip' | 'docx';
export type TemplateStatus = 'draft' | 'mapped' | 'verified' | 'retired';

export interface WorkActor {
  userId: string;
  organizationId: string;
  departmentId: string;
  isAdmin: boolean;
  managedDepartmentIds: string[];
}

export interface WorkTaskRow {
  id: string;
  organization_id: string;
  department_id: string;
  owner_id: string;
  workflow_key: WorkflowKey;
  workflow_version: string;
  agent_id: string | null;
  title: string;
  status: TaskStatus;
  revision: number;
  form: Record<string, unknown>;
  template_version_id: string | null;
  current_document_version_id: string | null;
  current_run_id: string | null;
  due_date: string | null;
  visibility: 'private' | 'explicit_members';
  approved_version_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface WorkMemberRow {
  task_id: string;
  user_id: string;
  role: MemberRole;
}

/** 필드 하나 = 양식의 채울 자리 하나. id는 그 양식 판(sha256) 안에서만 유효한 자리 번호(s1…)다 */
export interface DocumentField {
  id: string;
  label: string;
  kind: 'marker' | 'section' | 'cell';
  type: 'text' | 'paragraph';
  value: string;
  required: boolean;
  locked: boolean;
  origin: 'empty' | 'form' | 'ai' | 'user' | 'restore';
  /** 이 값의 근거가 된 원자료(work_sources.id) — 실제로 쓴 것만 */
  evidenceIds: string[];
  /** 자리 주변 글(양식이 준 힌트) */
  hint: string | null;
}

export interface WorkDocumentVersionRow {
  id: string;
  task_id: string;
  organization_id: string;
  version: number;
  parent_version_id: string | null;
  template_version_id: string | null;
  source_ids: string[];
  fields: DocumentField[];
  origin: 'generate' | 'edit' | 'revise' | 'restore' | 'import';
  change_reason: string;
  run_id: string | null;
  created_by: string | null;
  created_at: string;
}

export interface WorkRunError {
  code: string;
  safeMessage: string;
  retryable: boolean;
}

export interface WorkRunRow {
  id: string;
  task_id: string;
  organization_id: string;
  operation: RunOperation;
  idempotency_key: string;
  payload: Record<string, unknown>;
  payload_hash: string;
  base_version: number;
  input_document_version_id: string | null;
  status: RunStatus;
  attempt: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_until: string | null;
  cancel_requested_at: string | null;
  error: WorkRunError | null;
  result: Record<string, unknown> | null;
  requested_by: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface WorkArtifactRow {
  id: string;
  organization_id: string;
  task_id: string;
  document_version_id: string;
  run_id: string | null;
  output_key: string;
  format: ArtifactFormat;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  /** 서버 안에서만 쓴다 — 화면·모델에 내보내지 않는다 */
  storage_path: string;
  validation_status: 'pending' | 'valid' | 'invalid';
  validation: Record<string, unknown> | null;
  preview_status: 'pending' | 'ready' | 'failed' | 'unsupported';
  preview: Record<string, unknown> | null;
  created_at: string;
}

export interface WorkReviewItemRow {
  id: string;
  task_id: string;
  document_version_id: string;
  severity: 'blocking' | 'warning' | 'info';
  code: string;
  message: string;
  field_ids: string[];
  evidence_ids: string[];
  state: 'open' | 'resolved' | 'acknowledged';
  resolved_by: string | null;
  resolution_note: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface WorkSourceRow {
  id: string;
  task_id: string;
  organization_id: string;
  uploaded_by: string;
  purpose: 'reference' | 'data' | 'request' | 'template' | 'evidence';
  file_name: string;
  file_ext: string;
  size_bytes: number | null;
  sha256: string | null;
  storage_path: string;
  status: 'pending' | 'ready' | 'failed';
  extract_path: string | null;
  summary: Record<string, unknown> | null;
  failure_reason: string | null;
  created_at: string;
  confirmed_at: string | null;
}

/** 일관된 실패 코드(개편 04 문서 9절) */
export const WORK_ERROR_CODES = {
  TEMPLATE_MISSING: 'TEMPLATE_MISSING',
  TEMPLATE_UNSUPPORTED: 'TEMPLATE_UNSUPPORTED',
  OUTPUT_INVALID: 'OUTPUT_INVALID',
  OUTPUT_TOO_LARGE: 'OUTPUT_TOO_LARGE',
  PREVIEW_UNAVAILABLE: 'PREVIEW_UNAVAILABLE',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  SUPERSEDED: 'SUPERSEDED',
  REQUIRED_INPUT_MISSING: 'REQUIRED_INPUT_MISSING',
  LLM_UNAVAILABLE: 'LLM_UNAVAILABLE',
  LLM_INVALID_OUTPUT: 'LLM_INVALID_OUTPUT',
  USAGE_LIMIT: 'USAGE_LIMIT',
  STORAGE_FAILED: 'STORAGE_FAILED',
  WORKFLOW_NOT_READY: 'WORKFLOW_NOT_READY',
  FEATURE_DISABLED: 'FEATURE_DISABLED',
  NOT_FOUND: 'NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
  INVALID_INPUT: 'INVALID_INPUT',
  CANCELED: 'CANCELED',
} as const;
export type WorkErrorCode = keyof typeof WORK_ERROR_CODES;

export class WorkError extends Error {
  constructor(
    public code: WorkErrorCode,
    message: string,
    public status = 400,
    public details?: unknown
  ) {
    super(message);
    this.name = 'WorkError';
  }
}
