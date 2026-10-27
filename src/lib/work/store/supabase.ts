// src/lib/work/store/supabase.ts
import { supabaseAdmin } from '@/lib/supabaseAdmin';
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
 * 운영 구현 — service role(PostgREST). RLS를 우회하므로 모든 조회에 organization_id를 함께 건다.
 * 판·실행·lease 규칙은 0034의 SQL 함수(work_*)에 있고 pg.ts와 같은 함수를 부른다.
 */
function fail(error: { code?: string; message?: string; details?: string | null } | null): never {
  if (error?.code?.startsWith('WK')) mapDbError(error);
  throw new Error(`업무 DB 오류(${error?.code ?? '알 수 없음'}): ${(error?.message ?? '').slice(0, 200)}`);
}

export function createSupabaseWorkStore(db = supabaseAdmin): WorkStore {
  const store: WorkStore = {
    async getOrgSettings(organizationId) {
      const { data, error } = await db.from('work_org_settings').select('home_enabled, new_tasks_enabled').eq('organization_id', organizationId).maybeSingle();
      if (error) fail(error);
      return { homeEnabled: data?.home_enabled ?? false, newTasksEnabled: data?.new_tasks_enabled ?? false };
    },
    async getOrganizationName(organizationId) {
      const { data } = await db.from('organizations').select('name').eq('id', organizationId).maybeSingle();
      return data?.name ?? null;
    },
    async getDepartmentName(departmentId, organizationId) {
      const { data } = await db.from('departments').select('name').eq('id', departmentId).eq('organization_id', organizationId).maybeSingle();
      return data?.name ?? null;
    },
    async isUserActive(userId) {
      const { data, error } = await db.from('users').select('is_active').eq('id', userId).maybeSingle();
      if (error || !data) return false;
      return data.is_active !== false;
    },

    async insertTask(t) {
      const { data, error } = await db.from('work_tasks').insert(t).select('*').single();
      if (error) fail(error);
      return data as WorkTaskRow;
    },
    async getTask(id, organizationId) {
      const { data, error } = await db.from('work_tasks').select('*').eq('id', id).eq('organization_id', organizationId).maybeSingle();
      if (error) fail(error);
      return (data as WorkTaskRow) ?? null;
    },
    async getMembers(taskId) {
      const { data, error } = await db.from('work_task_members').select('task_id, user_id, role').eq('task_id', taskId);
      if (error) fail(error);
      return (data ?? []) as WorkMemberRow[];
    },
    async addMember(taskId, organizationId, userId, role, grantedBy) {
      const { error } = await db
        .from('work_task_members')
        .upsert({ task_id: taskId, organization_id: organizationId, user_id: userId, role, granted_by: grantedBy }, { onConflict: 'task_id,user_id' });
      if (error) fail(error);
      await db.from('work_tasks').update({ visibility: 'explicit_members' }).eq('id', taskId).eq('organization_id', organizationId);
    },
    async listTasks(q) {
      const { data: mem, error: memError } = await db
        .from('work_task_members')
        .select('task_id')
        .eq('organization_id', q.organizationId)
        .eq('user_id', q.userId)
        .limit(1000);
      if (memError) fail(memError);
      const memberIds = (mem ?? []).map((m: { task_id: string }) => m.task_id);
      let query = db.from('work_tasks').select('*').eq('organization_id', q.organizationId);
      query = memberIds.length ? query.or(`owner_id.eq.${q.userId},id.in.(${memberIds.join(',')})`) : query.eq('owner_id', q.userId);
      if (q.status?.length) query = query.in('status', q.status);
      if (q.workflowKey) query = query.eq('workflow_key', q.workflowKey);
      if (q.before) query = query.or(`updated_at.lt.${q.before.updatedAt},and(updated_at.eq.${q.before.updatedAt},id.lt.${q.before.id})`);
      const { data, error } = await query.order('updated_at', { ascending: false }).order('id', { ascending: false }).limit(q.limit);
      if (error) fail(error);
      return (data ?? []) as WorkTaskRow[];
    },
    async updateTaskIfRevision(id, organizationId, expectedRevision, patch) {
      const { data, error } = await db
        .from('work_tasks')
        .update({ ...patch, revision: expectedRevision + 1, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('organization_id', organizationId)
        .eq('revision', expectedRevision)
        .select('*')
        .maybeSingle();
      if (error) fail(error);
      return (data as WorkTaskRow) ?? null;
    },
    async setTaskStatus(id, organizationId, status, extra = {}) {
      const { error } = await db
        .from('work_tasks')
        .update({ ...extra, status, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('organization_id', organizationId);
      if (error) fail(error);
    },

    async saveVersion(i) {
      const { data, error } = await db.rpc('work_save_document_version', {
        p_task_id: i.taskId,
        p_org: i.organizationId,
        p_base_version: i.baseVersion,
        p_fields: i.fields,
        p_template_version_id: i.templateVersionId,
        p_origin: i.origin,
        p_reason: i.reason,
        p_actor: i.actorId,
        p_run_id: i.runId,
        p_source_ids: i.sourceIds,
        p_content: i.content ?? null,
      });
      if (error) fail(error);
      return data as WorkDocumentVersionRow;
    },
    async getVersion(id, organizationId) {
      const { data, error } = await db.from('work_document_versions').select('*').eq('id', id).eq('organization_id', organizationId).maybeSingle();
      if (error) fail(error);
      return (data as WorkDocumentVersionRow) ?? null;
    },
    async getVersionByRun(taskId, runId) {
      const { data, error } = await db.from('work_document_versions').select('*').eq('task_id', taskId).eq('run_id', runId).maybeSingle();
      if (error) fail(error);
      return (data as WorkDocumentVersionRow) ?? null;
    },
    async listVersions(taskId, organizationId) {
      const { data, error } = await db
        .from('work_document_versions')
        .select('*')
        .eq('task_id', taskId)
        .eq('organization_id', organizationId)
        .order('version', { ascending: false });
      if (error) fail(error);
      return (data ?? []) as WorkDocumentVersionRow[];
    },

    async enqueueRun(i) {
      const { data, error } = await db.rpc('work_enqueue_run', {
        p_task_id: i.taskId,
        p_org: i.organizationId,
        p_operation: i.operation,
        p_key: i.idempotencyKey,
        p_payload: i.payload,
        p_payload_hash: i.payloadHash,
        p_base_version: i.baseVersion,
        p_input_version: i.inputVersionId,
        p_requested_by: i.requestedBy,
        p_max_attempts: i.maxAttempts ?? 3,
      });
      if (error) fail(error);
      const row = (Array.isArray(data) ? data[0] : data) as { run: WorkRunRow; created: boolean };
      return { run: row.run, created: row.created };
    },
    async getRun(id, organizationId) {
      const { data, error } = await db.from('work_runs').select('*').eq('id', id).eq('organization_id', organizationId).maybeSingle();
      if (error) fail(error);
      return (data as WorkRunRow) ?? null;
    },
    async getActiveRun(taskId, organizationId) {
      const { data, error } = await db
        .from('work_runs')
        .select('*')
        .eq('task_id', taskId)
        .eq('organization_id', organizationId)
        .in('status', ['queued', 'running'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) fail(error);
      return (data as WorkRunRow) ?? null;
    },
    async claimRuns(worker, leaseSeconds, limit, runId = null) {
      const { data, error } = await db.rpc('work_claim_runs', { p_worker: worker, p_lease_seconds: leaseSeconds, p_limit: limit, p_run_id: runId });
      if (error) fail(error);
      return (data ?? []) as WorkRunRow[];
    },
    async heartbeat(runId, worker, leaseSeconds) {
      const { data, error } = await db.rpc('work_heartbeat_run', { p_run_id: runId, p_worker: worker, p_lease_seconds: leaseSeconds });
      if (error) fail(error);
      return Boolean(data);
    },
    async finishRun(runId, worker, status, errorValue, result, retryDelaySeconds) {
      const { data, error } = await db.rpc('work_finish_run', {
        p_run_id: runId,
        p_worker: worker,
        p_status: status,
        p_error: errorValue,
        p_result: result,
        p_retry_delay_seconds: retryDelaySeconds,
      });
      if (error) fail(error);
      return String(data);
    },
    async requestCancel(runId, organizationId) {
      const now = new Date().toISOString();
      const { data: queued, error } = await db
        .from('work_runs')
        .update({ status: 'canceled', cancel_requested_at: now, finished_at: now })
        .eq('id', runId)
        .eq('organization_id', organizationId)
        .eq('status', 'queued')
        .select('*')
        .maybeSingle();
      if (error) fail(error);
      if (queued) return queued as WorkRunRow;
      const { data: running, error: e2 } = await db
        .from('work_runs')
        .update({ cancel_requested_at: now })
        .eq('id', runId)
        .eq('organization_id', organizationId)
        .eq('status', 'running')
        .is('cancel_requested_at', null)
        .select('*')
        .maybeSingle();
      if (e2) fail(e2);
      return (running as WorkRunRow) ?? null;
    },
    async getStep(runId, step) {
      const { data, error } = await db.from('work_run_steps').select('run_id, step, attempt, status, output').eq('run_id', runId).eq('step', step).maybeSingle();
      if (error) fail(error);
      return (data as RunStepRow) ?? null;
    },
    async saveStep(runId, organizationId, step, attempt, status, output, err) {
      const { error } = await db.from('work_run_steps').upsert(
        {
          run_id: runId,
          organization_id: organizationId,
          step,
          attempt,
          status,
          output,
          error: err ?? null,
          finished_at: status === 'running' ? null : new Date().toISOString(),
        },
        { onConflict: 'run_id,step' }
      );
      if (error) fail(error);
    },

    async insertArtifact(a) {
      const { data, error } = await db
        .from('work_artifacts')
        .upsert(a, { onConflict: 'document_version_id,output_key', ignoreDuplicates: true })
        .select('*');
      if (error) fail(error);
      if (data && data.length) return { artifact: data[0] as WorkArtifactRow, created: true };
      const { data: existing, error: e2 } = await db
        .from('work_artifacts')
        .select('*')
        .eq('document_version_id', a.document_version_id)
        .eq('output_key', a.output_key)
        .eq('organization_id', a.organization_id)
        .single();
      if (e2) fail(e2);
      return { artifact: existing as WorkArtifactRow, created: false };
    },
    async getArtifact(id, organizationId) {
      const { data, error } = await db.from('work_artifacts').select('*').eq('id', id).eq('organization_id', organizationId).maybeSingle();
      if (error) fail(error);
      return (data as WorkArtifactRow) ?? null;
    },
    async listArtifacts(taskId, organizationId) {
      const { data, error } = await db
        .from('work_artifacts')
        .select('*')
        .eq('task_id', taskId)
        .eq('organization_id', organizationId)
        .order('created_at', { ascending: false });
      if (error) fail(error);
      return (data ?? []) as WorkArtifactRow[];
    },
    async updateArtifact(id, organizationId, patch) {
      const { error } = await db.from('work_artifacts').update(patch).eq('id', id).eq('organization_id', organizationId);
      if (error) fail(error);
    },

    async replaceReviewItems(taskId, organizationId, versionId, items) {
      const { error } = await db
        .from('work_review_items')
        .delete()
        .eq('document_version_id', versionId)
        .eq('organization_id', organizationId)
        .eq('state', 'open');
      if (error) fail(error);
      if (!items.length) return;
      const { error: e2 } = await db
        .from('work_review_items')
        .insert(items.map((it) => ({ ...it, organization_id: organizationId, task_id: taskId, document_version_id: versionId })));
      if (e2) fail(e2);
    },
    async listReviewItems(versionId, organizationId) {
      const { data, error } = await db
        .from('work_review_items')
        .select('*')
        .eq('document_version_id', versionId)
        .eq('organization_id', organizationId)
        .order('created_at');
      if (error) fail(error);
      return (data ?? []) as WorkReviewItemRow[];
    },
    async updateReviewItem(id, organizationId, versionId, patch) {
      const { data, error } = await db
        .from('work_review_items')
        .update(patch)
        .eq('id', id)
        .eq('organization_id', organizationId)
        .eq('document_version_id', versionId)
        .select('*')
        .maybeSingle();
      if (error) fail(error);
      return (data as WorkReviewItemRow) ?? null;
    },

    async insertSource(s) {
      const { data, error } = await db.from('work_sources').insert(s).select('*').single();
      if (error) fail(error);
      return data as WorkSourceRow;
    },
    async getSource(id, organizationId) {
      const { data, error } = await db.from('work_sources').select('*').eq('id', id).eq('organization_id', organizationId).maybeSingle();
      if (error) fail(error);
      return (data as WorkSourceRow) ?? null;
    },
    async listSources(taskId, organizationId) {
      const { data, error } = await db.from('work_sources').select('*').eq('task_id', taskId).eq('organization_id', organizationId).order('created_at');
      if (error) fail(error);
      return (data ?? []) as WorkSourceRow[];
    },
    async updateSource(id, organizationId, patch) {
      const { error } = await db.from('work_sources').update(patch).eq('id', id).eq('organization_id', organizationId);
      if (error) fail(error);
    },

    async findBuiltinTemplate(ref, sha256) {
      const { data, error } = await db
        .from('work_template_versions')
        .select('*')
        .eq('source', 'builtin')
        .eq('builtin_ref', ref)
        .eq('sha256', sha256)
        .maybeSingle();
      if (error) fail(error);
      return (data as TemplateVersionRow) ?? null;
    },
    async insertTemplateVersion(row) {
      const { data, error } = await db.from('work_template_versions').insert(row).select('*').maybeSingle();
      if (error && error.code !== '23505') fail(error);
      if (data) return data as TemplateVersionRow;
      // 동시에 같은 판을 넣었다 — 이미 있는 행
      if (row.source === 'builtin') return (await store.findBuiltinTemplate(row.builtin_ref!, row.sha256))!;
      const { data: existing, error: e2 } = await db
        .from('work_template_versions')
        .select('*')
        .eq('organization_id', row.organization_id!)
        .eq('sha256', row.sha256)
        .single();
      if (e2) fail(e2);
      return existing as TemplateVersionRow;
    },
    async getTemplateVersion(id, organizationId) {
      const { data, error } = await db
        .from('work_template_versions')
        .select('*')
        .eq('id', id)
        .or(`organization_id.is.null,organization_id.eq.${organizationId}`)
        .maybeSingle();
      if (error) fail(error);
      return (data as TemplateVersionRow) ?? null;
    },
    async listOrgTemplatesAdmin(organizationId) {
      const { data, error } = await db.from('work_template_versions').select('*').eq('organization_id', organizationId).order('created_at', { ascending: false });
      if (error) fail(error);
      return (data ?? []) as TemplateVersionRow[];
    },
    async updateTemplateVersion(id, organizationId, patch) {
      const upd: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (patch.status) upd.status = patch.status;
      if (patch.verification) upd.verification = patch.verification;
      const { data, error } = await db.from('work_template_versions').update(upd).eq('id', id).eq('organization_id', organizationId).select('*').maybeSingle();
      if (error) fail(error);
      return (data as TemplateVersionRow) ?? null;
    },
    async upsertOrgSettings(organizationId, s) {
      const { error } = await db
        .from('work_org_settings')
        .upsert({ organization_id: organizationId, home_enabled: s.homeEnabled, new_tasks_enabled: s.newTasksEnabled, updated_by: s.updatedBy, updated_at: new Date().toISOString() }, { onConflict: 'organization_id' });
      if (error) fail(error);
      return { homeEnabled: s.homeEnabled, newTasksEnabled: s.newTasksEnabled };
    },
    async listInstallations(organizationId) {
      const { data, error } = await db.from('workflow_installations').select('workflow_key, workflow_version, status, installed_by, updated_at').eq('organization_id', organizationId);
      if (error) fail(error);
      return (data ?? []) as WorkflowInstallationRow[];
    },
    async upsertInstallation(organizationId, workflowKey, s) {
      const { data, error } = await db
        .from('workflow_installations')
        .upsert({ organization_id: organizationId, workflow_key: workflowKey, workflow_version: s.workflowVersion, status: s.status, installed_by: s.installedBy, updated_at: new Date().toISOString() }, { onConflict: 'organization_id,workflow_key' })
        .select('workflow_key, workflow_version, status, installed_by, updated_at')
        .single();
      if (error) fail(error);
      return data as WorkflowInstallationRow;
    },
    async listLegacyFiles(userId, organizationId) {
      const [g, a] = await Promise.all([
        db.from('generated_files').select('id, file_name, size_bytes, created_at').eq('user_id', userId).eq('organization_id', organizationId).order('created_at', { ascending: false }).limit(50),
        db.from('chat_attachments').select('id, file_name, size_bytes, created_at').eq('user_id', userId).eq('organization_id', organizationId).eq('status', 'ready').order('created_at', { ascending: false }).limit(50),
      ]);
      if (g.error) fail(g.error);
      if (a.error) fail(a.error);
      return [
        ...((g.data ?? []) as Omit<LegacyFileRow, 'kind'>[]).map((r) => ({ ...r, kind: 'generated' as const })),
        ...((a.data ?? []) as Omit<LegacyFileRow, 'kind'>[]).map((r) => ({ ...r, kind: 'attachment' as const })),
      ].sort((x, y) => (x.created_at < y.created_at ? 1 : -1));
    },
    async getLegacyFile(kind, id, userId, organizationId) {
      let q = db.from(kind === 'generated' ? 'generated_files' : 'chat_attachments').select('file_name, storage_path, mime_type').eq('id', id).eq('user_id', userId).eq('organization_id', organizationId);
      if (kind === 'attachment') q = q.eq('status', 'ready');
      const { data, error } = await q.maybeSingle();
      if (error) fail(error);
      return (data as { file_name: string; storage_path: string; mime_type: string | null }) ?? null;
    },
    async listOrgAgentTemplates(organizationId) {
      const { data, error } = await db
        .from('agent_templates')
        .select('id, name, file_name, storage_path, agents!inner(name, organization_id, deleted_at)')
        .eq('agents.organization_id', organizationId)
        .is('agents.deleted_at', null)
        .is('retired_at', null)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) fail(error);
      return ((data ?? []) as unknown as { id: string; name: string; file_name: string; storage_path: string; agents: { name: string } }[]).map((r) => ({ id: r.id, name: r.name, file_name: r.file_name, storage_path: r.storage_path, agent_name: r.agents.name }));
    },
    async workStats(organizationId, sinceIso) {
      const [tasks, runs] = await Promise.all([
        db.from('work_tasks').select('workflow_key, status').eq('organization_id', organizationId).limit(10000),
        db.from('work_runs').select('task_id, error, work_tasks!inner(workflow_key, organization_id)').eq('organization_id', organizationId).eq('status', 'failed').gte('finished_at', sinceIso).limit(10000),
      ]);
      if (tasks.error) fail(tasks.error);
      if (runs.error) fail(runs.error);
      const by = new Map<string, WorkStatsRow>();
      for (const t of (tasks.data ?? []) as { workflow_key: string; status: string }[]) {
        const r = by.get(t.workflow_key) ?? { workflow_key: t.workflow_key, tasks: 0, completed: 0, needs_review: 0, failed_runs_30d: 0, top_error: null };
        r.tasks += 1;
        if (t.status === 'completed') r.completed += 1;
        if (t.status === 'needs_review') r.needs_review += 1;
        by.set(t.workflow_key, r);
      }
      const errors = new Map<string, Map<string, number>>();
      for (const x of (runs.data ?? []) as unknown as { error: { code?: string } | null; work_tasks: { workflow_key: string } }[]) {
        const k = x.work_tasks.workflow_key;
        const r = by.get(k) ?? { workflow_key: k, tasks: 0, completed: 0, needs_review: 0, failed_runs_30d: 0, top_error: null };
        r.failed_runs_30d += 1;
        by.set(k, r);
        const m = errors.get(k) ?? new Map<string, number>();
        const code = x.error?.code ?? 'UNKNOWN';
        m.set(code, (m.get(code) ?? 0) + 1);
        errors.set(k, m);
      }
      for (const [k, m] of errors) by.get(k)!.top_error = [...m].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      return [...by.values()].sort((a, b) => a.workflow_key.localeCompare(b.workflow_key));
    },
    async listTemplateVersions(organizationId) {
      const { data, error } = await db
        .from('work_template_versions')
        .select('*')
        .or(`organization_id.is.null,organization_id.eq.${organizationId}`)
        .neq('status', 'retired')
        .order('name')
        .order('version', { ascending: false });
      if (error) fail(error);
      return (data ?? []) as TemplateVersionRow[];
    },

    async insertProposal(p) {
      const { data, error } = await db.from('work_revision_proposals').insert(p).select('*').single();
      if (error) fail(error);
      return data as ProposalRow;
    },
    async getProposal(id, organizationId) {
      const { data, error } = await db.from('work_revision_proposals').select('*').eq('id', id).eq('organization_id', organizationId).maybeSingle();
      if (error) fail(error);
      return (data as ProposalRow) ?? null;
    },
    async updateProposal(id, organizationId, patch, expectStatus) {
      let q = db.from('work_revision_proposals').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).eq('organization_id', organizationId);
      if (expectStatus) q = q.eq('status', expectStatus);
      const { data, error } = await q.select('*').maybeSingle();
      if (error) fail(error);
      return (data as ProposalRow) ?? null;
    },

    async insertEvent(e) {
      const { error } = await db
        .from('work_events')
        .insert({ organization_id: e.organizationId, task_id: e.taskId, actor_id: e.actorId, type: e.type, details: e.details ?? {} });
      if (error) console.error('[work] 이벤트 기록 실패', e.type, error.message);
    },
    async writeUsage(u) {
      // organization_id는 트리거(0012/0022)가 department_id로부터 채운다
      const { error } = await db.from('usage_logs').insert({
        department_id: u.departmentId,
        user_id: u.userId,
        action: u.action,
        resource_type: 'work_run',
        resource_id: u.resourceId,
        details: u.details,
      });
      if (error) console.error('[work] 사용 기록 실패', u.action, error.message);
    },
  };
  return store;
}
