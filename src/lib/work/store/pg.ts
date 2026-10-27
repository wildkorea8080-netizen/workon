// src/lib/work/store/pg.ts
import type { Pool, PoolClient } from 'pg';
import { mapDbError } from './errors';
import type { WorkStore, TemplateVersionRow, RunStepRow, ProposalRow, WorkflowInstallationRow, LegacyFileRow, WorkStatsRow } from './types';
import type {
  WorkArtifactRow,
  WorkDocumentVersionRow,
  WorkMemberRow,
  WorkReviewItemRow,
  WorkRunRow,
  WorkSourceRow,
  WorkTaskRow,
} from '../types';

/**
 * 직접 Postgres 연결 구현 — 통합 시험과 DATABASE_URL로 붙는 로컬 작업자가 쓴다(앱 서버는 supabase.ts).
 * 표·칸 이름은 0034 그대로다. 갱신할 칸 이름은 코드가 정한 허용 목록만 받는다(동적 SQL에 값이 아닌 이름이 들어가므로).
 */
type Q = Pool | PoolClient;

const TASK_PATCH = new Set(['title', 'due_date', 'form', 'template_version_id', 'status', 'archived_at', 'approved_version_id', 'approved_by', 'approved_at', 'visibility']);
const ARTIFACT_PATCH = new Set(['validation_status', 'validation', 'preview_status', 'preview']);
const REVIEW_PATCH = new Set(['state', 'resolved_by', 'resolution_note', 'resolved_at']);
const SOURCE_PATCH = new Set(['status', 'sha256', 'size_bytes', 'extract_path', 'summary', 'failure_reason', 'confirmed_at']);
const PROPOSAL_PATCH = new Set(['status', 'proposal', 'run_id', 'applied_version_id']);

/** jsonb 칸 — 배열도 JSON으로 보낸다(그냥 넘기면 pg가 Postgres 배열 문법으로 바꿔 jsonb에 들어가지 않는다) */
const JSON_COLUMNS = new Set(['form', 'validation', 'preview', 'summary', 'proposal', 'origin', 'payload', 'result', 'error', 'fields']);

function setClause(patch: Record<string, unknown>, allowed: Set<string>, start: number): { sql: string; values: unknown[] } {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  for (const k of keys) if (!allowed.has(k)) throw new Error(`허용되지 않은 칸: ${k}`);
  const values = keys.map((k) => {
    const v = patch[k];
    if (v === null) return null;
    return JSON_COLUMNS.has(k) ? JSON.stringify(v) : v;
  });
  return { sql: keys.map((k, i) => `${k} = $${start + i}`).join(', '), values };
}

async function one<T>(db: Q, sql: string, params: unknown[]): Promise<T | null> {
  const { rows } = await db.query(sql, params);
  return (rows[0] as T) ?? null;
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { code?: string; message?: string; detail?: string };
    if (err.code?.startsWith('WK')) mapDbError(err);
    throw e;
  }
}

export function createPgWorkStore(db: Pool): WorkStore {
  return {
    async getOrgSettings(organizationId) {
      const r = await one<{ home_enabled: boolean; new_tasks_enabled: boolean }>(
        db,
        'SELECT home_enabled, new_tasks_enabled FROM work_org_settings WHERE organization_id = $1',
        [organizationId]
      );
      return { homeEnabled: r?.home_enabled ?? false, newTasksEnabled: r?.new_tasks_enabled ?? false };
    },
    async getOrganizationName(organizationId) {
      return (await one<{ name: string }>(db, 'SELECT name FROM organizations WHERE id = $1', [organizationId]))?.name ?? null;
    },
    async getDepartmentName(departmentId, organizationId) {
      return (await one<{ name: string }>(db, 'SELECT name FROM departments WHERE id = $1 AND organization_id = $2', [departmentId, organizationId]))?.name ?? null;
    },
    async isUserActive(userId) {
      const r = await one<{ is_active: boolean | null }>(db, 'SELECT is_active FROM users WHERE id = $1', [userId]);
      return Boolean(r) && r!.is_active !== false;
    },

    async insertTask(t) {
      return (await one<WorkTaskRow>(
        db,
        `INSERT INTO work_tasks (organization_id, department_id, owner_id, workflow_key, workflow_version, title, form, template_version_id, due_date, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [t.organization_id, t.department_id, t.owner_id, t.workflow_key, t.workflow_version, t.title, JSON.stringify(t.form), t.template_version_id, t.due_date, t.status]
      ))!;
    },
    async getTask(id, organizationId) {
      return one<WorkTaskRow>(db, 'SELECT * FROM work_tasks WHERE id = $1 AND organization_id = $2', [id, organizationId]);
    },
    async getMembers(taskId) {
      const { rows } = await db.query('SELECT task_id, user_id, role FROM work_task_members WHERE task_id = $1', [taskId]);
      return rows as WorkMemberRow[];
    },
    async addMember(taskId, organizationId, userId, role, grantedBy) {
      await db.query(
        `INSERT INTO work_task_members (task_id, organization_id, user_id, role, granted_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (task_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [taskId, organizationId, userId, role, grantedBy]
      );
      await db.query(`UPDATE work_tasks SET visibility = 'explicit_members' WHERE id = $1 AND organization_id = $2`, [taskId, organizationId]);
    },
    async listTasks(q) {
      const params: unknown[] = [q.organizationId, q.userId];
      let where = `t.organization_id = $1 AND (t.owner_id = $2 OR EXISTS (SELECT 1 FROM work_task_members m WHERE m.task_id = t.id AND m.user_id = $2))`;
      if (q.status?.length) {
        params.push(q.status);
        where += ` AND t.status = ANY($${params.length})`;
      }
      if (q.workflowKey) {
        params.push(q.workflowKey);
        where += ` AND t.workflow_key = $${params.length}`;
      }
      if (q.before) {
        params.push(q.before.updatedAt, q.before.id);
        where += ` AND (t.updated_at, t.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
      }
      params.push(q.limit);
      const { rows } = await db.query(`SELECT t.* FROM work_tasks t WHERE ${where} ORDER BY t.updated_at DESC, t.id DESC LIMIT $${params.length}`, params);
      return rows as WorkTaskRow[];
    },
    async updateTaskIfRevision(id, organizationId, expectedRevision, patch) {
      const s = setClause(patch as Record<string, unknown>, TASK_PATCH, 4);
      return one<WorkTaskRow>(
        db,
        `UPDATE work_tasks SET ${s.sql}, revision = revision + 1, updated_at = now()
          WHERE id = $1 AND organization_id = $2 AND revision = $3 RETURNING *`,
        [id, organizationId, expectedRevision, ...s.values]
      );
    },
    async setTaskStatus(id, organizationId, status, extra = {}) {
      const s = setClause({ ...extra, status } as Record<string, unknown>, TASK_PATCH, 3);
      await db.query(`UPDATE work_tasks SET ${s.sql}, updated_at = now() WHERE id = $1 AND organization_id = $2`, [id, organizationId, ...s.values]);
    },

    async saveVersion(i) {
      return call(async () =>
        (await one<WorkDocumentVersionRow>(
          db,
          'SELECT * FROM work_save_document_version($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11::jsonb)',
          [i.taskId, i.organizationId, i.baseVersion, JSON.stringify(i.fields), i.templateVersionId, i.origin, i.reason, i.actorId, i.runId, i.sourceIds,
           i.content ? JSON.stringify(i.content) : null]
        ))!
      );
    },
    async getVersion(id, organizationId) {
      return one<WorkDocumentVersionRow>(db, 'SELECT * FROM work_document_versions WHERE id = $1 AND organization_id = $2', [id, organizationId]);
    },
    async getVersionByRun(taskId, runId) {
      return one<WorkDocumentVersionRow>(db, 'SELECT * FROM work_document_versions WHERE task_id = $1 AND run_id = $2', [taskId, runId]);
    },
    async listVersions(taskId, organizationId) {
      const { rows } = await db.query(
        'SELECT * FROM work_document_versions WHERE task_id = $1 AND organization_id = $2 ORDER BY version DESC',
        [taskId, organizationId]
      );
      return rows as WorkDocumentVersionRow[];
    },

    async enqueueRun(i) {
      return call(async () => {
        const r = await one<WorkRunRow & { created: boolean }>(
          db,
          'SELECT (run).*, created FROM work_enqueue_run($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)',
          [i.taskId, i.organizationId, i.operation, i.idempotencyKey, JSON.stringify(i.payload), i.payloadHash, i.baseVersion, i.inputVersionId, i.requestedBy, i.maxAttempts ?? 3]
        );
        const { created, ...run } = r!;
        return { run: run as WorkRunRow, created };
      });
    },
    async getRun(id, organizationId) {
      return one<WorkRunRow>(db, 'SELECT * FROM work_runs WHERE id = $1 AND organization_id = $2', [id, organizationId]);
    },
    async getActiveRun(taskId, organizationId) {
      return one<WorkRunRow>(
        db,
        "SELECT * FROM work_runs WHERE task_id = $1 AND organization_id = $2 AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1",
        [taskId, organizationId],
      );
    },
    async claimRuns(worker, leaseSeconds, limit, runId = null) {
      const { rows } = await db.query('SELECT * FROM work_claim_runs($1,$2,$3,$4)', [worker, leaseSeconds, limit, runId]);
      return rows as WorkRunRow[];
    },
    async heartbeat(runId, worker, leaseSeconds) {
      return Boolean((await one<{ ok: boolean }>(db, 'SELECT work_heartbeat_run($1,$2,$3) AS ok', [runId, worker, leaseSeconds]))?.ok);
    },
    async finishRun(runId, worker, status, error, result, retryDelaySeconds) {
      return (await one<{ s: string }>(db, 'SELECT work_finish_run($1,$2,$3,$4::jsonb,$5::jsonb,$6) AS s', [
        runId,
        worker,
        status,
        error ? JSON.stringify(error) : null,
        result ? JSON.stringify(result) : null,
        retryDelaySeconds,
      ]))!.s;
    },
    async requestCancel(runId, organizationId) {
      // 대기 중이면 바로 취소, 실행 중이면 요청만 남긴다(작업자가 단계 사이에 본다)
      return one<WorkRunRow>(
        db,
        `UPDATE work_runs SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
                status = CASE WHEN status = 'queued' THEN 'canceled' ELSE status END,
                finished_at = CASE WHEN status = 'queued' THEN now() ELSE finished_at END
          WHERE id = $1 AND organization_id = $2 AND status IN ('queued','running') RETURNING *`,
        [runId, organizationId]
      );
    },
    async getStep(runId, step) {
      return one<RunStepRow>(db, 'SELECT run_id, step, attempt, status, output FROM work_run_steps WHERE run_id = $1 AND step = $2', [runId, step]);
    },
    async saveStep(runId, organizationId, step, attempt, status, output, error) {
      await db.query(
        `INSERT INTO work_run_steps (run_id, organization_id, step, attempt, status, output, error, finished_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb, CASE WHEN $5 = 'running' THEN NULL ELSE now() END)
         ON CONFLICT (run_id, step) DO UPDATE SET attempt = EXCLUDED.attempt, status = EXCLUDED.status, output = EXCLUDED.output,
                                                  error = EXCLUDED.error, finished_at = EXCLUDED.finished_at`,
        [runId, organizationId, step, attempt, status, output ? JSON.stringify(output) : null, error ? JSON.stringify(error) : null]
      );
    },

    async insertArtifact(a) {
      const inserted = await one<WorkArtifactRow>(
        db,
        `INSERT INTO work_artifacts (organization_id, task_id, document_version_id, run_id, output_key, format, file_name, mime_type, size_bytes, sha256,
                                     storage_path, validation_status, validation, preview_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
         ON CONFLICT (document_version_id, output_key) DO NOTHING RETURNING *`,
        [a.organization_id, a.task_id, a.document_version_id, a.run_id, a.output_key, a.format, a.file_name, a.mime_type, a.size_bytes, a.sha256,
         a.storage_path, a.validation_status, a.validation ? JSON.stringify(a.validation) : null, a.preview_status]
      );
      if (inserted) return { artifact: inserted, created: true };
      const existing = await one<WorkArtifactRow>(
        db,
        'SELECT * FROM work_artifacts WHERE document_version_id = $1 AND output_key = $2 AND organization_id = $3',
        [a.document_version_id, a.output_key, a.organization_id]
      );
      return { artifact: existing!, created: false };
    },
    async getArtifact(id, organizationId) {
      return one<WorkArtifactRow>(db, 'SELECT * FROM work_artifacts WHERE id = $1 AND organization_id = $2', [id, organizationId]);
    },
    async listArtifacts(taskId, organizationId) {
      const { rows } = await db.query('SELECT * FROM work_artifacts WHERE task_id = $1 AND organization_id = $2 ORDER BY created_at DESC', [taskId, organizationId]);
      return rows as WorkArtifactRow[];
    },
    async updateArtifact(id, organizationId, patch) {
      const s = setClause(patch as Record<string, unknown>, ARTIFACT_PATCH, 3);
      await db.query(`UPDATE work_artifacts SET ${s.sql} WHERE id = $1 AND organization_id = $2`, [id, organizationId, ...s.values]);
    },

    async replaceReviewItems(taskId, organizationId, versionId, items) {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM work_review_items WHERE document_version_id = $1 AND organization_id = $2 AND state = 'open'`, [versionId, organizationId]);
        for (const it of items) {
          await client.query(
            `INSERT INTO work_review_items (organization_id, task_id, document_version_id, severity, code, message, field_ids)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [organizationId, taskId, versionId, it.severity, it.code, it.message, it.field_ids]
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    async listReviewItems(versionId, organizationId) {
      const { rows } = await db.query('SELECT * FROM work_review_items WHERE document_version_id = $1 AND organization_id = $2 ORDER BY created_at', [versionId, organizationId]);
      return rows as WorkReviewItemRow[];
    },
    async updateReviewItem(id, organizationId, versionId, patch) {
      const s = setClause(patch as Record<string, unknown>, REVIEW_PATCH, 4);
      return one<WorkReviewItemRow>(
        db,
        `UPDATE work_review_items SET ${s.sql} WHERE id = $1 AND organization_id = $2 AND document_version_id = $3 RETURNING *`,
        [id, organizationId, versionId, ...s.values]
      );
    },

    async insertSource(s) {
      return (await one<WorkSourceRow>(
        db,
        `INSERT INTO work_sources (id, task_id, organization_id, uploaded_by, purpose, file_name, file_ext, size_bytes, storage_path, origin)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING *`,
        [s.id, s.task_id, s.organization_id, s.uploaded_by, s.purpose, s.file_name, s.file_ext, s.size_bytes, s.storage_path, s.origin ? JSON.stringify(s.origin) : null]
      ))!;
    },
    async getSource(id, organizationId) {
      return one<WorkSourceRow>(db, 'SELECT * FROM work_sources WHERE id = $1 AND organization_id = $2', [id, organizationId]);
    },
    async listSources(taskId, organizationId) {
      const { rows } = await db.query('SELECT * FROM work_sources WHERE task_id = $1 AND organization_id = $2 ORDER BY created_at', [taskId, organizationId]);
      return rows as WorkSourceRow[];
    },
    async updateSource(id, organizationId, patch) {
      const s = setClause(patch as Record<string, unknown>, SOURCE_PATCH, 3);
      await db.query(`UPDATE work_sources SET ${s.sql} WHERE id = $1 AND organization_id = $2`, [id, organizationId, ...s.values]);
    },

    async findBuiltinTemplate(ref, sha256) {
      return one<TemplateVersionRow>(db, `SELECT * FROM work_template_versions WHERE source = 'builtin' AND builtin_ref = $1 AND sha256 = $2`, [ref, sha256]);
    },
    async insertTemplateVersion(row) {
      const inserted = await one<TemplateVersionRow>(
        db,
        `INSERT INTO work_template_versions (organization_id, source, builtin_ref, agent_template_id, storage_path, name, file_name, format, sha256, version, status, manifest, supported, verification)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb)
         ON CONFLICT DO NOTHING RETURNING *`,
        [row.organization_id, row.source, row.builtin_ref, row.agent_template_id, row.storage_path, row.name, row.file_name, row.format, row.sha256,
         row.version, row.status, JSON.stringify(row.manifest), JSON.stringify(row.supported), row.verification ? JSON.stringify(row.verification) : null]
      );
      if (inserted) return inserted;
      // 동시에 같은 판을 넣었다 — 이미 있는 행
      const existing =
        row.source === 'builtin'
          ? await this.findBuiltinTemplate(row.builtin_ref!, row.sha256)
          : await one<TemplateVersionRow>(db, 'SELECT * FROM work_template_versions WHERE organization_id = $1 AND sha256 = $2', [row.organization_id, row.sha256]);
      return existing!;
    },
    async getTemplateVersion(id, organizationId) {
      return one<TemplateVersionRow>(
        db,
        'SELECT * FROM work_template_versions WHERE id = $1 AND (organization_id IS NULL OR organization_id = $2)',
        [id, organizationId]
      );
    },
    async listOrgTemplatesAdmin(organizationId) {
      const { rows } = await db.query('SELECT * FROM work_template_versions WHERE organization_id = $1 ORDER BY created_at DESC', [organizationId]);
      return rows as TemplateVersionRow[];
    },
    async updateTemplateVersion(id, organizationId, patch) {
      return one<TemplateVersionRow>(
        db,
        `UPDATE work_template_versions SET status = COALESCE($3, status), verification = CASE WHEN $4::jsonb IS NULL THEN verification ELSE $4::jsonb END, updated_at = now()
         WHERE id = $1 AND organization_id = $2 RETURNING *`,
        [id, organizationId, patch.status ?? null, patch.verification ? JSON.stringify(patch.verification) : null]
      );
    },
    async upsertOrgSettings(organizationId, s) {
      await db.query(
        `INSERT INTO work_org_settings (organization_id, home_enabled, new_tasks_enabled, updated_by, updated_at) VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (organization_id) DO UPDATE SET home_enabled = EXCLUDED.home_enabled, new_tasks_enabled = EXCLUDED.new_tasks_enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [organizationId, s.homeEnabled, s.newTasksEnabled, s.updatedBy]
      );
      return { homeEnabled: s.homeEnabled, newTasksEnabled: s.newTasksEnabled };
    },
    async listInstallations(organizationId) {
      const { rows } = await db.query('SELECT workflow_key, workflow_version, status, installed_by, updated_at FROM workflow_installations WHERE organization_id = $1', [organizationId]);
      return rows as WorkflowInstallationRow[];
    },
    async upsertInstallation(organizationId, workflowKey, s) {
      return (await one<WorkflowInstallationRow>(
        db,
        `INSERT INTO workflow_installations (organization_id, workflow_key, workflow_version, status, installed_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (organization_id, workflow_key) DO UPDATE SET status = EXCLUDED.status, workflow_version = EXCLUDED.workflow_version, installed_by = EXCLUDED.installed_by, updated_at = now()
         RETURNING workflow_key, workflow_version, status, installed_by, updated_at`,
        [organizationId, workflowKey, s.workflowVersion, s.status, s.installedBy]
      ))!;
    },
    async listLegacyFiles(userId, organizationId) {
      const { rows } = await db.query(
        `(SELECT 'generated' AS kind, id, file_name, size_bytes, created_at FROM generated_files WHERE user_id = $1 AND organization_id = $2 ORDER BY created_at DESC LIMIT 50)
         UNION ALL
         (SELECT 'attachment' AS kind, id, file_name, size_bytes, created_at FROM chat_attachments WHERE user_id = $1 AND organization_id = $2 AND status = 'ready' ORDER BY created_at DESC LIMIT 50)
         ORDER BY created_at DESC`,
        [userId, organizationId]
      );
      return rows as LegacyFileRow[];
    },
    async getLegacyFile(kind, id, userId, organizationId) {
      const table = kind === 'generated' ? 'generated_files' : 'chat_attachments';
      const extra = kind === 'attachment' ? " AND status = 'ready'" : '';
      return one<{ file_name: string; storage_path: string; mime_type: string | null }>(
        db,
        `SELECT file_name, storage_path, mime_type FROM ${table} WHERE id = $1 AND user_id = $2 AND organization_id = $3${extra}`,
        [id, userId, organizationId]
      );
    },
    async listOrgAgentTemplates(organizationId) {
      const { rows } = await db.query(
        `SELECT t.id, t.name, t.file_name, t.storage_path, a.name AS agent_name FROM agent_templates t JOIN agents a ON a.id = t.agent_id
         WHERE a.organization_id = $1 AND a.deleted_at IS NULL AND t.retired_at IS NULL ORDER BY t.created_at DESC LIMIT 100`,
        [organizationId]
      );
      return rows as { id: string; name: string; file_name: string; storage_path: string; agent_name: string }[];
    },
    async workStats(organizationId, sinceIso) {
      const { rows } = await db.query(
        `SELECT t.workflow_key,
                count(*)::int AS tasks,
                count(*) FILTER (WHERE t.status = 'completed')::int AS completed,
                count(*) FILTER (WHERE t.status = 'needs_review')::int AS needs_review,
                (SELECT count(*)::int FROM work_runs r JOIN work_tasks t2 ON t2.id = r.task_id WHERE t2.organization_id = $1 AND t2.workflow_key = t.workflow_key AND r.status = 'failed' AND r.finished_at >= $2) AS failed_runs_30d,
                (SELECT r.error->>'code' FROM work_runs r JOIN work_tasks t2 ON t2.id = r.task_id WHERE t2.organization_id = $1 AND t2.workflow_key = t.workflow_key AND r.status = 'failed' AND r.finished_at >= $2
                  GROUP BY r.error->>'code' ORDER BY count(*) DESC LIMIT 1) AS top_error
           FROM work_tasks t WHERE t.organization_id = $1 GROUP BY t.workflow_key ORDER BY t.workflow_key`,
        [organizationId, sinceIso]
      );
      return rows as WorkStatsRow[];
    },
    async listTemplateVersions(organizationId) {
      const { rows } = await db.query(
        `SELECT * FROM work_template_versions WHERE (organization_id IS NULL OR organization_id = $1) AND status <> 'retired' ORDER BY organization_id NULLS LAST, name, version DESC`,
        [organizationId]
      );
      return rows as TemplateVersionRow[];
    },

    async insertProposal(p) {
      return (await one<ProposalRow>(
        db,
        `INSERT INTO work_revision_proposals (organization_id, task_id, base_version, field_ids, instruction, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [p.organization_id, p.task_id, p.base_version, p.field_ids, p.instruction, p.created_by]
      ))!;
    },
    async getProposal(id, organizationId) {
      return one<ProposalRow>(db, 'SELECT * FROM work_revision_proposals WHERE id = $1 AND organization_id = $2', [id, organizationId]);
    },
    async updateProposal(id, organizationId, patch, expectStatus) {
      const s = setClause(patch as Record<string, unknown>, PROPOSAL_PATCH, 3);
      const params: unknown[] = [id, organizationId, ...s.values];
      let cond = '';
      if (expectStatus) {
        params.push(expectStatus);
        cond = ` AND status = $${params.length}`;
      }
      return one<ProposalRow>(db, `UPDATE work_revision_proposals SET ${s.sql}, updated_at = now() WHERE id = $1 AND organization_id = $2${cond} RETURNING *`, params);
    },

    async insertEvent(e) {
      await db.query('INSERT INTO work_events (organization_id, task_id, actor_id, type, details) VALUES ($1,$2,$3,$4,$5::jsonb)', [
        e.organizationId,
        e.taskId,
        e.actorId,
        e.type,
        JSON.stringify(e.details ?? {}),
      ]);
    },
    async writeUsage(u) {
      await db.query(
        `INSERT INTO usage_logs (department_id, user_id, action, resource_type, resource_id, details) VALUES ($1,$2,$3,'work_run',$4,$5::jsonb)`,
        [u.departmentId, u.userId, u.action, u.resourceId, JSON.stringify(u.details)]
      );
    },
  };
}
