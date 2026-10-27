/**
 * WORKON vNext contract draft, not runtime implementation.
 * Keep runtime validators, SQL constraints and these types aligned.
 * All scope/identity/storage values are server-derived, never model authority.
 */
export type Id = string;
export type WorkflowKey =
  | 'intake' | 'official-letter' | 'report' | 'collection' | 'settlement'
  | 'regulations' | 'meeting' | 'reply' | 'audit-response' | 'handover';

export type TaskStatus =
  | 'draft' | 'ready' | 'processing' | 'needs_review'
  | 'approved' | 'completed' | 'archived';
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'superseded';
export type RunOperation = 'generate' | 'revise' | 'validate' | 'render' | 'package';
export type MemberRole = 'viewer' | 'editor' | 'reviewer';
export type ArtifactFormat = 'hwpx' | 'xlsx' | 'pdf' | 'zip';
export type TemplateStatus = 'draft' | 'mapped' | 'verified' | 'retired';

export interface WorkActor {
  userId: Id;
  organizationId: Id;
  departmentId: Id;
  visibleDepartmentIds: Id[];
  managedDepartmentIds: Id[];
  active: boolean;
}

export interface WorkTask {
  id: Id;
  organizationId: Id;
  departmentId: Id;
  ownerId: Id;
  workflowKey: WorkflowKey;
  workflowVersion: string;
  agentId: Id;
  agentVersion: number;
  title: string;
  status: TaskStatus;
  /** Metadata concurrency; document edits also check document version. */
  revision: number;
  currentDocumentVersionId: Id | null;
  currentRunId: Id | null;
  dueDate: string | null;
  visibility: 'private' | 'explicit_members';
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceLocator {
  sourceVersionId: Id;
  kind: 'page' | 'cell' | 'table' | 'audio_span' | 'text_span';
  /** Only actual parsed coordinates; absent means unknown, never estimated. */
  page?: number;
  sheet?: string;
  cell?: string;
  tableId?: string;
  extractedRow?: number;
  sourceRow?: number;
  startMs?: number;
  endMs?: number;
  paragraphId?: string;
  quote?: string;
}

export interface FieldCommon {
  id: Id;
  templateBindingId: string;
  label: string;
  required: boolean;
  locked: boolean;
  origin: 'source' | 'calculation' | 'ai' | 'user';
  evidenceIds: Id[];
}
export type Scalar = string | number | null;
export type DocumentField = FieldCommon & (
  | { type: 'text'; value: string }
  | { type: 'paragraph'; value: string[] }
  | { type: 'table'; columns: { id: string; label: string; unit?: string }[]; rows: Scalar[][]; calculationResultHash?: string }
  | { type: 'image'; sourceAssetId: Id; alt: string; widthMm: number; heightMm: number; caption?: string }
);

export interface WorkDocumentVersion {
  id: Id;
  taskId: Id;
  organizationId: Id;
  version: number;
  parentVersionId: Id | null;
  templateVersionId: Id;
  sourceVersionIds: Id[];
  fields: DocumentField[];
  createdBy: Id;
  createdAt: string;
  changeReason: string;
}

export interface TemplateVersion {
  id: Id;
  organizationId: Id | null; // null only for explicitly managed standard templates
  existingAgentTemplateId: Id | null;
  version: number;
  sha256: string;
  status: TemplateStatus;
  supported: { text: boolean; paragraphs: boolean; existingCells: boolean; repeatRows: boolean; imageInsert: boolean; exactPreview: boolean };
  verification: { checkedAt: string; application: string; applicationVersion: string; result: 'passed' | 'failed'; evidenceRef: string } | null;
}

export interface WorkRun {
  id: Id;
  taskId: Id;
  organizationId: Id;
  operation: RunOperation;
  inputDocumentVersionId: Id | null;
  inputHash: string;
  idempotencyKey: string;
  status: RunStatus;
  attempt: number;
  leaseOwner: string | null;
  leaseUntil: string | null;
  cancelRequestedAt: string | null;
  error: { code: string; safeMessage: string; retryable: boolean } | null;
}

export interface WorkArtifact {
  id: Id;
  organizationId: Id;
  taskId: Id;
  documentVersionId: Id;
  runId: Id;
  format: ArtifactFormat;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  validationStatus: 'pending' | 'valid' | 'invalid';
  /** Private server-side only. Never include in public task DTO/model input. */
  storageKey: string;
  previewStatus: 'pending' | 'ready' | 'failed' | 'unsupported';
}

export interface RenderedPreview {
  artifactId: Id;
  inputSha256: string;
  renderer: { name: string; version: string };
  kind: 'actual_file_render';
  pageCount: number;
  pages: { page: number; privateObjectKey: string }[];
  warnings: string[];
}
export interface DocumentRenderer {
  health(): Promise<{ available: boolean; supportsHwpx: boolean; supportsPdf: boolean; reason?: string }>;
  render(request: { artifactId: Id; expectedSha256: string; privateInputRef: string; correlationId: Id }): Promise<RenderedPreview>;
}

export type FieldPatch =
  | { fieldId: Id; operation: 'set_value'; value: unknown }
  | { fieldId: Id; operation: 'set_lock'; value: boolean };
export interface SaveDocumentRequest { baseVersion: number; patches: FieldPatch[] }
export interface CreateRunRequest { operation: RunOperation; baseVersion: number; options: Record<string, unknown> }
export interface CreateRevisionProposalRequest { baseVersion: number; fieldIds: Id[]; instruction: string }

export interface ReviewItem {
  id: Id;
  taskId: Id;
  documentVersionId: Id;
  severity: 'blocking' | 'warning' | 'info';
  code: string;
  message: string;
  fieldIds: Id[];
  evidenceIds: Id[];
  state: 'open' | 'resolved' | 'acknowledged';
  resolvedBy: Id | null;
  resolutionNote: string | null;
}

export type WorkApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

/** Evaluate on server against latest policy and current version, never client-only. */
export interface CompletionGate {
  currentVersionId: Id;
  requiredArtifactsValidAndPresent: boolean;
  artifactsMatchCurrentVersion: boolean;
  blockingReviewItems: number;
  reviewerApprovedCurrentVersion: boolean;
}

export function canMarkCompleted(gate: CompletionGate): boolean {
  return gate.requiredArtifactsValidAndPresent
    && gate.artifactsMatchCurrentVersion
    && gate.blockingReviewItems === 0
    && gate.reviewerApprovedCurrentVersion;
}
