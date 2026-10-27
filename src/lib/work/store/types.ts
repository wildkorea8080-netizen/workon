// src/lib/work/store/types.ts
import type {
  DocumentField,
  MemberRole,
  RunOperation,
  WorkArtifactRow,
  WorkDocumentVersionRow,
  WorkMemberRow,
  WorkReviewItemRow,
  WorkRunError,
  WorkRunRow,
  WorkSourceRow,
  WorkTaskRow,
  WorkflowKey,
} from '../types';

/**
 * 업무 도메인의 DB 경계. 구현이 둘이다:
 *  - supabase.ts — 운영(앱 서버, service role · PostgREST)
 *  - pg.ts       — 직접 Postgres 연결(통합 시험, DATABASE_URL로 붙는 로컬 작업자)
 * 두 구현은 같은 SQL 함수(0034의 work_* RPC)를 부르므로 판·실행·lease 규칙은 DB 한 곳에 있다.
 *
 * 이 경계는 권한을 판정하지 않는다 — 권한은 서비스가 access.ts로 본다. 대신 모든 조회는 id와 함께
 * organization_id를 받아 기관을 넘는 행을 돌려주지 않는다(심층 방어).
 */
export interface TemplateVersionRow {
  id: string;
  organization_id: string | null;
  source: 'builtin' | 'agent_template' | 'upload';
  builtin_ref: string | null;
  agent_template_id: string | null;
  storage_path: string | null;
  name: string;
  file_name: string;
  format: 'hwpx' | 'docx' | 'xlsx';
  sha256: string;
  version: number;
  status: 'draft' | 'mapped' | 'verified' | 'retired';
  manifest: { slots?: { id: string; label: string; kind: 'marker' | 'section' | 'cell'; hint: string | null }[] } & Record<string, unknown>;
  supported: Record<string, boolean>;
  verification: Record<string, unknown> | null;
  created_at: string;
}

export interface NewTask {
  organization_id: string;
  department_id: string;
  owner_id: string;
  workflow_key: WorkflowKey;
  workflow_version: string;
  title: string;
  form: Record<string, unknown>;
  template_version_id: string | null;
  due_date: string | null;
  status: 'draft' | 'ready';
}

export interface TaskListQuery {
  organizationId: string;
  userId: string;
  status?: string[];
  workflowKey?: string;
  limit: number;
  /** updated_at|id 커서(이전 쪽의 마지막 행) */
  before?: { updatedAt: string; id: string } | null;
}

export interface SaveVersionInput {
  taskId: string;
  organizationId: string;
  baseVersion: number;
  fields: DocumentField[];
  templateVersionId: string | null;
  origin: WorkDocumentVersionRow['origin'];
  reason: string;
  actorId: string | null;
  runId: string | null;
  sourceIds: string[];
  /** 문서 칸이 아닌 업무 결과(취합 결과·직원 결정) */
  content?: Record<string, unknown> | null;
}

export interface EnqueueInput {
  taskId: string;
  organizationId: string;
  operation: RunOperation;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  baseVersion: number;
  inputVersionId: string | null;
  requestedBy: string;
  maxAttempts?: number;
}

export interface RunStepRow {
  run_id: string;
  step: string;
  attempt: number;
  status: 'running' | 'succeeded' | 'failed';
  output: Record<string, unknown> | null;
}

export interface NewArtifact {
  organization_id: string;
  task_id: string;
  document_version_id: string;
  run_id: string | null;
  output_key: string;
  format: WorkArtifactRow['format'];
  file_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  storage_path: string;
  validation_status: WorkArtifactRow['validation_status'];
  validation: Record<string, unknown> | null;
  preview_status: WorkArtifactRow['preview_status'];
}

export interface NewReviewItem {
  severity: WorkReviewItemRow['severity'];
  code: string;
  message: string;
  field_ids: string[];
}

export interface NewSource {
  id: string;
  task_id: string;
  organization_id: string;
  uploaded_by: string;
  purpose: WorkSourceRow['purpose'];
  file_name: string;
  file_ext: string;
  size_bytes: number | null;
  storage_path: string;
  origin?: Record<string, unknown> | null;
}

export interface ProposalRow {
  id: string;
  organization_id: string;
  task_id: string;
  base_version: number;
  field_ids: string[];
  instruction: string;
  status: 'pending' | 'ready' | 'applied' | 'rejected' | 'failed' | 'stale';
  proposal: { fieldId: string; before: string; after: string }[] | null;
  run_id: string | null;
  applied_version_id: string | null;
  created_by: string;
  created_at: string;
}

export interface OrgWorkSettings {
  homeEnabled: boolean;
  newTasksEnabled: boolean;
}

export interface WorkflowInstallationRow {
  workflow_key: string;
  workflow_version: string;
  status: 'preparing' | 'available' | 'disabled';
  installed_by: string | null;
  updated_at: string;
}

/** 대화에서 만든 파일·대화 첨부 — 본인 것만(가져오기 목록) */
export interface LegacyFileRow {
  kind: 'generated' | 'attachment';
  id: string;
  file_name: string;
  size_bytes: number | null;
  created_at: string;
}

/** 기관 관리자 현황 — 원문 없이 숫자만 */
export interface WorkStatsRow {
  workflow_key: string;
  tasks: number;
  completed: number;
  needs_review: number;
  failed_runs_30d: number;
  top_error: string | null;
}

export interface UsageRecord {
  departmentId: string;
  userId: string;
  action: string;
  resourceId: string;
  details: Record<string, unknown>;
}

export interface WorkStore {
  // 기관·사용자
  getOrgSettings(organizationId: string): Promise<OrgWorkSettings>;
  getOrganizationName(organizationId: string): Promise<string | null>;
  /** 그 기관의 부서일 때만 이름(다른 기관 부서 id면 null) */
  getDepartmentName(departmentId: string, organizationId: string): Promise<string | null>;
  isUserActive(userId: string): Promise<boolean>;

  // 작업
  insertTask(task: NewTask): Promise<WorkTaskRow>;
  getTask(id: string, organizationId: string): Promise<WorkTaskRow | null>;
  getMembers(taskId: string): Promise<WorkMemberRow[]>;
  addMember(taskId: string, organizationId: string, userId: string, role: MemberRole, grantedBy: string): Promise<void>;
  listTasks(q: TaskListQuery): Promise<WorkTaskRow[]>;
  /** revision이 기대와 같을 때만 바꾼다(제목·기한 등 메타데이터 동시 수정). 바뀐 행 또는 null */
  updateTaskIfRevision(id: string, organizationId: string, expectedRevision: number, patch: Partial<WorkTaskRow>): Promise<WorkTaskRow | null>;
  /** 실행·검토가 상태를 옮길 때 — 조건 없이(서비스가 이미 판정함) */
  setTaskStatus(id: string, organizationId: string, status: WorkTaskRow['status'], extra?: Partial<WorkTaskRow>): Promise<void>;

  // 문서 판
  saveVersion(input: SaveVersionInput): Promise<WorkDocumentVersionRow>;
  getVersion(id: string, organizationId: string): Promise<WorkDocumentVersionRow | null>;
  getVersionByRun(taskId: string, runId: string): Promise<WorkDocumentVersionRow | null>;
  listVersions(taskId: string, organizationId: string): Promise<WorkDocumentVersionRow[]>;

  // 실행
  enqueueRun(input: EnqueueInput): Promise<{ run: WorkRunRow; created: boolean }>;
  getRun(id: string, organizationId: string): Promise<WorkRunRow | null>;
  /** 이 작업에서 아직 끝나지 않은(대기·처리 중) 가장 최근 실행 — 저장·복구가 건 파일 만들기를 다시 열어도 보이게 */
  getActiveRun(taskId: string, organizationId: string): Promise<WorkRunRow | null>;
  claimRuns(worker: string, leaseSeconds: number, limit: number, runId?: string | null): Promise<WorkRunRow[]>;
  heartbeat(runId: string, worker: string, leaseSeconds: number): Promise<boolean>;
  finishRun(runId: string, worker: string, status: 'succeeded' | 'failed', error: WorkRunError | null, result: Record<string, unknown> | null, retryDelaySeconds: number): Promise<string>;
  requestCancel(runId: string, organizationId: string): Promise<WorkRunRow | null>;
  getStep(runId: string, step: string): Promise<RunStepRow | null>;
  saveStep(runId: string, organizationId: string, step: string, attempt: number, status: RunStepRow['status'], output: Record<string, unknown> | null, error?: unknown): Promise<void>;

  // 파일
  /** 같은 (판, 산출물 키)가 이미 있으면 그 행을 돌려준다 — 다시 시도해도 두 벌이 생기지 않는다 */
  insertArtifact(a: NewArtifact): Promise<{ artifact: WorkArtifactRow; created: boolean }>;
  getArtifact(id: string, organizationId: string): Promise<WorkArtifactRow | null>;
  listArtifacts(taskId: string, organizationId: string): Promise<WorkArtifactRow[]>;
  updateArtifact(id: string, organizationId: string, patch: Partial<WorkArtifactRow>): Promise<void>;

  // 확인할 사항
  replaceReviewItems(taskId: string, organizationId: string, versionId: string, items: NewReviewItem[]): Promise<void>;
  listReviewItems(versionId: string, organizationId: string): Promise<WorkReviewItemRow[]>;
  updateReviewItem(id: string, organizationId: string, versionId: string, patch: Partial<WorkReviewItemRow>): Promise<WorkReviewItemRow | null>;

  // 원자료
  insertSource(s: NewSource): Promise<WorkSourceRow>;
  getSource(id: string, organizationId: string): Promise<WorkSourceRow | null>;
  listSources(taskId: string, organizationId: string): Promise<WorkSourceRow[]>;
  updateSource(id: string, organizationId: string, patch: Partial<WorkSourceRow>): Promise<void>;

  // 양식 판
  findBuiltinTemplate(ref: string, sha256: string): Promise<TemplateVersionRow | null>;
  insertTemplateVersion(row: Omit<TemplateVersionRow, 'id' | 'created_at'>): Promise<TemplateVersionRow>;
  getTemplateVersion(id: string, organizationId: string): Promise<TemplateVersionRow | null>;
  listTemplateVersions(organizationId: string): Promise<TemplateVersionRow[]>;
  /** 관리자 — 이 기관 양식 전부(사용 중지 포함) */
  listOrgTemplatesAdmin(organizationId: string): Promise<TemplateVersionRow[]>;
  updateTemplateVersion(id: string, organizationId: string, patch: Partial<Pick<TemplateVersionRow, 'status' | 'verification'>>): Promise<TemplateVersionRow | null>;
  /** 기관 스위치(슈퍼관리자) */
  upsertOrgSettings(organizationId: string, s: { homeEnabled: boolean; newTasksEnabled: boolean; updatedBy: string | null }): Promise<OrgWorkSettings>;
  listInstallations(organizationId: string): Promise<WorkflowInstallationRow[]>;
  upsertInstallation(organizationId: string, workflowKey: string, s: { status: WorkflowInstallationRow['status']; workflowVersion: string; installedBy: string | null }): Promise<WorkflowInstallationRow>;
  /** 본인이 대화에서 만든 파일·올린 첨부(읽힘) — 최근 것부터 */
  listLegacyFiles(userId: string, organizationId: string): Promise<LegacyFileRow[]>;
  /** 본인 것·같은 기관일 때만 */
  getLegacyFile(kind: LegacyFileRow['kind'], id: string, userId: string, organizationId: string): Promise<{ file_name: string; storage_path: string; mime_type: string | null } | null>;
  /** 이 기관 비서에 올린 대화용 양식(지운 비서·사용 중지 제외) */
  listOrgAgentTemplates(organizationId: string): Promise<{ id: string; name: string; file_name: string; storage_path: string; agent_name: string }[]>;
  workStats(organizationId: string, sinceIso: string): Promise<WorkStatsRow[]>;

  // AI 수정 후보
  insertProposal(p: Omit<ProposalRow, 'id' | 'created_at' | 'proposal' | 'applied_version_id' | 'status' | 'run_id'>): Promise<ProposalRow>;
  getProposal(id: string, organizationId: string): Promise<ProposalRow | null>;
  updateProposal(id: string, organizationId: string, patch: Partial<ProposalRow>, expectStatus?: ProposalRow['status']): Promise<ProposalRow | null>;

  // 기록
  /** taskId null = 기관 단위 사건(관리자) */
  insertEvent(e: { organizationId: string; taskId: string | null; actorId: string | null; type: string; details?: Record<string, unknown> }): Promise<void>;
  writeUsage(u: UsageRecord): Promise<void>;
}
