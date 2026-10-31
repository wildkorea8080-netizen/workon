import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import JSZip from 'jszip';
import { createPgWorkStore } from '@/lib/work/store/pg';
import { createLocalWorkFiles } from '@/lib/work/files';
import { unavailableRenderer } from '@/lib/work/documents/renderer';
import { createSourceUpload, confirmSource } from '@/lib/work/sources';
import { runWorker } from '@/lib/work/runs/worker';
import type { WorkContext } from '@/lib/work/context';
import type { WorkActor } from '@/lib/work/types';
import * as svc from '@/lib/work/services';

const url = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!url)('앱 설정·RAG·실제 PostgreSQL·HWPX 연결', () => {
  let pool: pg.Pool; let ctx: WorkContext; let actor: WorkActor; let agentId: string;
  const orgDocuments = vi.fn();
  const compose = vi.fn();
  const answer = vi.fn();
  beforeAll(async () => {
    const target = new URL(url!);
    if (!['localhost', '127.0.0.1'].includes(target.hostname) || !target.pathname.startsWith('/workon_')) throw new Error('명시적인 로컬 시험 DB만 허용');
    pool = new pg.Pool({ connectionString: url, max: 3 });
    const org = randomUUID(), dept = randomUUID(), user = randomUUID(); agentId = randomUUID();
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2)', [org, '앱통합시험기관']);
    await pool.query('INSERT INTO departments(id,name,slug,organization_id) VALUES($1,$2,$3,$4)', [dept, '업무과', dept, org]);
    await pool.query('INSERT INTO users(id,email,department_id) VALUES($1,$2,$3)', [user, `${user}@test.local`, dept]);
    await pool.query('INSERT INTO agents(id,name,department_id,organization_id,tier,visibility,is_published) VALUES($1,$2,$3,$4,$5,$6,true)', [agentId, '시험 비서', dept, org, 'official', 'organization']);
    await pool.query('INSERT INTO work_org_settings(organization_id,new_tasks_enabled) VALUES($1,true)', [org]);
    actor = { userId: user, organizationId: org, departmentId: dept, isAdmin: false, managedDepartmentIds: [] };
    orgDocuments.mockResolvedValue({ status: 'ok', items: [{ kind: 'org_doc', title: '운영 기준', location: 'p.3', text: '주차장은 매일 운영합니다.', effectiveDate: null, editionYear: null, issuer: null, url: null }] });
    compose.mockImplementation(async (input, opts) => {
      expect(opts.appInstruction).toBe('간결하게 작성');
      expect(input.sources.some((s: { id: string }) => s.id.startsWith('rag:'))).toBe(true);
      const source = input.sources.find((s: { id: string }) => s.id.startsWith('rag:'));
      return { values: Object.fromEntries(input.targetIds.map((id: string) => [id, { value: '주차장은 매일 운영합니다.', evidenceIds: [source.id] }])), missing: [], usage: null, mode: 'llm' };
    });
    answer.mockImplementation(async (input, opts) => {
      expect(opts.appInstruction).toBe('간결하게 작성');
      const source = input.evidenceSources.find((s: { id: string }) => s.id.startsWith('rag:'));
      expect(source).toBeDefined();
      return { raw: { questions: [{ text: '운영 여부', quote: '주차장은 매일 운영하나요?', sourceId: 'inquiry' }], answers: [{ question: 1, text: '주차장은 매일 운영합니다.', evidence: [source.id], status: 'answered' }], priorDiffs: [] }, usage: null, mode: 'llm' };
    });
    ctx = { store: createPgWorkStore(pool), files: createLocalWorkFiles(mkdtempSync(path.join(tmpdir(), 'workon-app-flow-'))), generator: { compose }, generatorMode: 'llm', renderer: unavailableRenderer,
      qa: { model: { answer } }, regulations: { providers: { orgDocuments, common: async () => ({ status: 'ok', items: [] }), laws: async () => ({ status: 'ok', items: [] }) }, model: {} as never },
      loadAppSnapshot: async () => ({ schemaVersion: 1, agentId, name: '시험 비서', version: 3, systemPrompt: '간결하게 작성', requestedModel: 'requested', capturedAt: new Date().toISOString(), documentSearchEligible: true }),
      resolveModel: async (_dept, requested) => { expect(requested).toBe('requested'); return 'allowed'; }, checkLimit: async () => ({ allowed: true }), log: async () => {}, now: () => new Date() };
  });
  afterAll(async () => { await pool?.end(); });
  it('스냅샷 ID 불일치는 DB가 거부하고 원본 수정은 저장 설정을 바꾸지 않는다', async () => {
    const task = await svc.createTask(ctx, actor, { workflowKey: 'reply', title: '설정 보존', agentId, form: { inquiry: '문의', confirmedFacts: '문의 접수' } });
    await pool.query('UPDATE agents SET name=$1 WHERE id=$2', ['바뀐 비서 이름', agentId]);
    expect((await ctx.store.getTask(task.id, actor.organizationId))?.app_snapshot).toMatchObject({ name: '시험 비서', version: 3 });
    await expect(pool.query('UPDATE work_tasks SET app_snapshot=$1 WHERE id=$2', [JSON.stringify({ ...task.app_snapshot, agentId: randomUUID() }), task.id])).rejects.toMatchObject({ code: '23514' });
  });
  it('문서 검색 실패 시 생성 모델과 파일 생성까지 진행하지 않는다', async () => {
    const task = await svc.createTask(ctx, actor, { workflowKey: 'reply', title: '검색 실패', agentId, documentScope: 'selected-agent', form: { inquiry: '문의', confirmedFacts: '문의 접수' } });
    const calls = answer.mock.calls.length;
    orgDocuments.mockResolvedValueOnce({ status: 'unavailable', reason: '시험 장애' });
    const request = await svc.requestGenerate(ctx, actor, task.id, { baseVersion: 0, idempotencyKey: randomUUID() });
    const outcome = await runWorker(ctx, { workerId: 'app-failure', runId: request.run.id });
    expect(outcome[0].error?.code).toBe('SOURCE_UNAVAILABLE');
    expect(answer.mock.calls.length).toBe(calls);
    const detail = await svc.getTaskDetail(ctx, actor, task.id);
    expect(detail.version).toBeNull();
    expect(detail.currentArtifacts).toHaveLength(0);
  });
  it.each(['report', 'reply'] as const)('%s 생성·근거 보존·직원 수정·파일 검사', async (workflowKey) => {
    const task = await svc.createTask(ctx, actor, { workflowKey, title: '운영 안내', agentId, documentScope: 'selected-agent', form: workflowKey === 'report' ? { reportType: '진행 현황', period: '2026년' } : { inquiry: '주차장은 매일 운영하나요?', confirmedFacts: '주차장 운영 여부 문의가 접수됨', recipient: '민원인' } });
    expect((await ctx.store.getTask(task.id, actor.organizationId))?.app_snapshot).toMatchObject({ version: 3, documentScope: 'selected-agent' });
    if (workflowKey === 'report') {
      const bytes = Buffer.from('주차장 운영 현황', 'utf8');
      const up = await createSourceUpload(ctx, task, actor.userId, { fileName: '현황.txt', size: bytes.length, purpose: 'reference' });
      await ctx.files.put(up.path, bytes, 'text/plain');
      await confirmSource(ctx, task, up.sourceId);
      await svc.refreshReadiness(ctx, (await ctx.store.getTask(task.id, actor.organizationId))!);
    }
    const request = await svc.requestGenerate(ctx, actor, task.id, { baseVersion: 0, idempotencyKey: randomUUID() });
    const outcome = await runWorker(ctx, { workerId: 'app-flow', runId: request.run.id });
    expect(outcome[0]).toMatchObject({ finish: 'succeeded' });
    const detail = await svc.getTaskDetail(ctx, actor, task.id);
    expect(detail.version?.appEvidence).toEqual([expect.objectContaining({ name: '운영 기준 · p.3', text: '주차장은 매일 운영합니다.' })]);
    expect(orgDocuments).toHaveBeenCalledWith(expect.objectContaining({ agentId }), expect.any(String));
    const artifact = detail.currentArtifacts.find((a) => a.format === 'hwpx')!;
    expect(artifact.validation_status).toBe('valid');
    const file = await ctx.store.getArtifact(artifact.id, actor.organizationId);
    const zip = await JSZip.loadAsync((await ctx.files.get(file!.storage_path))!);
    expect(await zip.file('Contents/section0.xml')!.async('string')).toContain('주차장은 매일 운영합니다.');
    const field = detail.version!.fields.find((f) => f.origin === 'ai' && f.value)!;
    await svc.saveDocument(ctx, actor, task.id, { baseVersion: 1, patches: [{ fieldId: field.id, operation: 'set_value', value: '직원 검토 내용' }] });
    const edited = await svc.getTaskDetail(ctx, actor, task.id);
    expect(edited.version?.appEvidence).toEqual(detail.version?.appEvidence);
  });
});
