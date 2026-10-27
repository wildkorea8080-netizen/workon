// 업무 화면이 받는 응답 꼴(src/lib/work/services.ts의 DTO와 맞춘다)
export interface WorkflowInputDto {
  key: string;
  label: string;
  type: 'string' | 'long-text' | 'date' | 'enum' | 'file-set' | 'template' | 'string-list' | 'record-list';
  required: boolean;
  options?: string[];
}

export interface WorkflowSummaryDto {
  key: string;
  name: string;
  group: 'A' | 'B' | 'C';
  purpose: string;
  outputs: { key: string; label: string; format: 'hwpx' | 'xlsx'; required: boolean }[];
  inputs: WorkflowInputDto[];
  scopeNote: string;
  available: boolean;
  reason: string | null;
  defaultTemplateRef: string | null;
}

export interface TaskDto {
  id: string;
  title: string;
  workflowKey: string;
  workflowName: string;
  status: string;
  revision: number;
  dueDate: string | null;
  form: Record<string, unknown>;
  templateVersionId: string | null;
  currentDocumentVersionId: string | null;
  currentRunId: string | null;
  approvedVersionId: string | null;
  isOwner: boolean;
  role: string | null;
  access: { edit: boolean; review: boolean; download: boolean };
  createdAt: string;
  updatedAt: string;
}

export interface FieldDto {
  id: string;
  label: string;
  kind: 'marker' | 'section' | 'cell';
  type: 'text' | 'paragraph';
  value: string;
  required: boolean;
  locked: boolean;
  origin: 'empty' | 'form' | 'ai' | 'user' | 'restore' | 'system';
  evidenceIds: string[];
  hint: string | null;
}

export interface ArtifactDto {
  id: string;
  document_version_id: string;
  output_key: string;
  format: string;
  file_name: string;
  size_bytes: number;
  sha256: string;
  validation_status: 'pending' | 'valid' | 'invalid';
  preview_status: 'pending' | 'ready' | 'failed' | 'unsupported';
  preview: { pageCount: number | null; renderer: { name: string; version: string } | null; reason: string | null; hasPdf: boolean };
  created_at: string;
  current?: boolean;
  taskTitle?: string;
}

export interface RunDto {
  id: string;
  operation: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  error: { code: string; message: string; retryable: boolean } | null;
  result: Record<string, unknown> | null;
  cancelRequested: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CollectionResultDto {
  schema: 'collection/1';
  outputUnit: string;
  fields: { name: string; kind: string; unit: string | null; derived: string | null }[];
  departments: { name: string; status: 'submitted' | 'missing'; sourceIds: string[]; values: Record<string, number | null> }[];
  totals: Record<string, number | null>;
  provisional: boolean;
  sources: { id: string; name: string; department: string | null; departmentBy: string | null; status: string; duplicateOf: string | null; table: string | null; columnMap: Record<string, string | null>; units: Record<string, string | null>; rowsUsed: number }[];
  decisions: { excludedSourceIds: string[]; includedSourceIds: string[]; outputUnit: string; allowProvisional: boolean; departmentOverrides: Record<string, string> };
}

export interface TaskDetailDto {
  task: TaskDto;
  kind: 'document' | 'collection' | 'regulations' | 'items';
  workflow: { key: string; name: string; purpose: string; inputs: WorkflowInputDto[]; outputs: WorkflowSummaryDto['outputs']; scopeNote: string; validationRules: string[] };
  template: { id: string; name: string; status: string; label: string; fieldCount: number } | null;
  version: { id: string; version: number; origin: string; changeReason: string; createdAt: string; fields: FieldDto[]; collection: CollectionResultDto | null; regulations: RegulationsDto | null; items: ItemsDto | null } | null;
  review: { id: string; severity: 'blocking' | 'warning' | 'info'; code: string; message: string; fieldIds: string[]; state: string; resolutionNote: string | null }[];
  artifacts: ArtifactDto[];
  currentArtifacts: ArtifactDto[];
  sources: { id: string; file_name: string; file_ext: string; size_bytes: number | null; status: string; failure_reason: string | null; purpose: string; summary: Record<string, unknown> | null; created_at: string }[];
  run: RunDto | null;
  generatorMode: 'llm' | 'mock';
  producedOutputs: string[];
}

export interface TemplatesDto {
  builtin: { ref: string; name: string; status: string; label: string; id: string | null; reason: string | null }[];
  organization: { id: string; name: string; format: string; status: string; label: string; fieldCount: number }[];
}

export interface RegulationEvidenceDto {
  id: string;
  kind: 'org_doc' | 'common' | 'law' | 'ordinance' | 'upload';
  title: string;
  location: string | null;
  effectiveDate: string | null;
  editionYear: number | null;
  applicability: 'applicable' | 'date_unknown' | 'after_basis' | 'other_org';
  note: string | null;
  text: string;
  url: string | null;
}

export interface RegulationsDto {
  basisDate: string;
  mode: 'llm' | 'mock';
  unavailable: string[];
  findings: { text: string; evidenceIds: string[]; dateCheck: boolean }[];
  reservations: { text: string; reason: string }[];
  evidence: RegulationEvidenceDto[];
}

export interface ItemsDto {
  name: string;
  typeLabel: string;
  columns: { key: string; label: string; type: string }[];
  items: { id: string; type: string; values: Record<string, string>; sourceName: string | null; quote: string; flags: string[]; notes: string[] }[];
  meta: Record<string, string>;
  extra: { label: string; values: Record<string, string> }[] | null;
}
