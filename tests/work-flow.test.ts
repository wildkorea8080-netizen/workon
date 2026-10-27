import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { randomUUID, createHash } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import JSZip from 'jszip';
import { createPgWorkStore } from '@/lib/work/store/pg';
import { createLocalWorkFiles } from '@/lib/work/files';
import { unavailableRenderer } from '@/lib/work/documents/renderer';
import type { WorkContext } from '@/lib/work/context';
import type { FieldGenerator, ComposeInput } from '@/lib/work/generation/compose';
import type { WorkStore } from '@/lib/work/store/types';
import type { WorkActor } from '@/lib/work/types';
import * as svc from '@/lib/work/services';
import { runWorker } from '@/lib/work/runs/worker';
import { checkPackage } from '@/lib/work/documents/package-check';

/**
 * 업무 흐름 통합 시험 — 실제 서비스·실행기·채우기 엔진을 실제 Postgres(0034)와 로컬 파일 저장소에 붙여 본다.
 * 모델만 가짜(FakeGenerator)다. WORK_TEST_DATABASE_URL이 있을 때만 돈다(`npm run work:testdb -- start`).
 * 개편 08 문서 시나리오 A03·A05·A07~A13·A20~A22를 서버 쪽에서 확인한다.
 */
const url = process.env.WORK_TEST_DATABASE_URL;
const key = () => `k-${randomUUID()}`;

class FakeGenerator implements FieldGenerator {
  calls = 0;
  failNext = 0;
  async compose(input: ComposeInput) {
    this.calls += 1;
    if (this.failNext > 0) {
      this.failNext -= 1;
      const { WorkError } = await import('@/lib/work/types');
      throw new WorkError('LLM_UNAVAILABLE', '가짜 모델 장애', 503);
    }
    const values: Record<string, { value: string; evidenceIds: string[] }> = {};
    const missing: { fieldId: string; reason: string }[] = [];
    for (const f of input.fields.filter((x) => input.targetIds.includes(x.id))) {
      if (f.label === '발신명의') missing.push({ fieldId: f.id, reason: '발신 명의가 입력에 없습니다' });
      else if (f.label === '경유') values[f.id] = { value: '', evidenceIds: [] };
      else values[f.id] = { value: input.instruction ? `${f.label} 수정본(${input.instruction})` : f.type === 'paragraph' ? `1. ${f.label} 내용입니다.\n2. 예산 1,234,000원 집행` : `${f.label} 값`, evidenceIds: [] };
    }
    return { values, missing, usage: { model: 'claude-sonnet-4-6', input_tokens: 100, output_tokens: 50 }, mode: 'llm' as const };
  }
}

describe.skipIf(!url)('업무 흐름 통합(실제 Postgres·실제 HWPX)', () => {
  let pool: pg.Pool;
  let store: WorkStore;
  let ctx: WorkContext;
  let gen: FakeGenerator;
  let a: { orgId: string; deptId: string; userId: string; actor: WorkActor };
  let b: { orgId: string; deptId: string; userId: string; actor: WorkActor };
  const filesRoot = mkdtempSync(path.join(tmpdir(), 'workon-files-'));

  async function seedOrg(label: string, enabled = true) {
    const orgId = randomUUID();
    const deptId = randomUUID();
    const userId = randomUUID();
    await pool.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, `가상기관${label}`]);
    await pool.query('INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, $2, $3, $4)', [deptId, `부서${label}`, `d-${deptId.slice(0, 8)}`, orgId]);
    await pool.query('INSERT INTO users (id, email, department_id) VALUES ($1, $2, $3)', [userId, `${userId}@test.local`, deptId]);
    if (enabled) await pool.query('INSERT INTO work_org_settings (organization_id, home_enabled, new_tasks_enabled) VALUES ($1, true, true)', [orgId]);
    const actor: WorkActor = { userId, organizationId: orgId, departmentId: deptId, isAdmin: false, managedDepartmentIds: [] };
    return { orgId, deptId, userId, actor };
  }

  async function addUser(o: { orgId: string; deptId: string }, isAdmin = false): Promise<WorkActor> {
    const userId = randomUUID();
    await pool.query('INSERT INTO users (id, email, department_id, role) VALUES ($1, $2, $3, $4)', [userId, `${userId}@test.local`, o.deptId, isAdmin ? 'ADMIN' : 'USER']);
    return { userId, organizationId: o.orgId, departmentId: o.deptId, isAdmin, managedDepartmentIds: isAdmin ? [o.deptId] : [] };
  }

  const letterForm = { facts: '2026년 3분기 사업 실적 제출을 요청함. 기한 2026. 10. 30.', recipients: ['기획팀장', '사업팀장'], attachments: [{ name: '실적 제출 양식 1부' }] };

  async function newTask(actor = a.actor) {
    return svc.createTask(ctx, actor, { workflowKey: 'official-letter', title: '3분기 실적 제출 요청', form: letterForm });
  }

  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    pool = new pg.Pool({ connectionString: url, max: 5 });
    store = createPgWorkStore(pool);
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    gen = new FakeGenerator();
    ctx = {
      store,
      files: createLocalWorkFiles(filesRoot),
      generator: gen,
      generatorMode: 'llm',
      renderer: unavailableRenderer,
      resolveModel: async () => 'claude-sonnet-4-6',
      checkLimit: async () => ({ allowed: true }),
      log: async (p) => { if (p.level === 'error') console.error('[work-log]', JSON.stringify(p.details)); },
      now: () => new Date(),
    };
    a = await seedOrg('A');
    b = await seedOrg('B');
  });

  it('기관 스위치가 꺼져 있으면 새 작업을 만들 수 없다', async () => {
    const off = await seedOrg('C', false);
    await expect(newTask(off.actor)).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
  });

  it('A03 — 양식·사실 입력 후 파일 만들기 한 번으로 실제 HWPX가 생기고 확인할 사항이 붙는다', async () => {
    const task = await newTask();
    expect(task.status).toBe('ready');
    const r = await svc.requestGenerate(ctx, a.actor, task.id, { baseVersion: 0, idempotencyKey: key() });
    expect(r.created).toBe(true);
    const outcomes = await runWorker(ctx, { workerId: 'w-test', runId: r.run.id });
    expect(outcomes[0].finish).toBe('succeeded');

    const d = await svc.getTaskDetail(ctx, a.actor, task.id);
    expect(d.task.status).toBe('needs_review');
    expect(d.version?.version).toBe(1);
    const byLabel = Object.fromEntries(d.version!.fields.map((f) => [f.label, f]));
    // 폼에서 바로 채운 칸은 모델을 거치지 않는다
    expect(byLabel['제목']).toMatchObject({ value: '3분기 실적 제출 요청', origin: 'form' });
    expect(byLabel['수신']).toMatchObject({ value: '수신자 참조', origin: 'form' });
    expect(byLabel['행정기관명'].value).toBe('가상기관A');
    // A05 — 없는 발신명의는 지어내지 않고 비워 두며 막는 확인 사항이 된다
    expect(byLabel['발신명의'].value).toBe('');
    expect(d.review.find((i) => i.code === 'REQUIRED_EMPTY')?.message).toMatch(/발신명의/);
    // 입력·원자료에 없는 숫자는 확인되지 않은 숫자로 표시
    expect(d.review.some((i) => i.code === 'UNVERIFIED_NUMBER')).toBe(true);

    const art = d.currentArtifacts[0];
    expect(art).toMatchObject({ format: 'hwpx', validation_status: 'valid', preview_status: 'unsupported' });
    const row = (await store.getArtifact(art.id, a.orgId))!;
    const bytes = (await ctx.files.get(row.storage_path))!;
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(art.sha256);
    const check = await checkPackage(bytes, { format: 'hwpx', values: ['3분기 실적 제출 요청', '수신자 참조'] });
    expect(check.valid).toBe(true);
    expect(JSON.stringify(art)).not.toContain('storage_path');

    // 과금 규약 — 모델·토큰·원가·실행 번호
    const usage = await pool.query(`SELECT details FROM usage_logs WHERE action = 'work_generate' AND resource_id = $1`, [r.run.id]);
    expect(usage.rows[0].details).toMatchObject({ model: 'claude-sonnet-4-6', input_tokens: 100, run_id: r.run.id, task_id: task.id });
    expect(usage.rows[0].details.cost_krw).toBeGreaterThan(0);
  });

  it('A11 — 같은 요청 번호는 같은 실행, 같은 번호에 다른 내용은 409', async () => {
    const task = await newTask();
    const k = key();
    const r1 = await svc.requestGenerate(ctx, a.actor, task.id, { baseVersion: 0, idempotencyKey: k });
    const r2 = await svc.requestGenerate(ctx, a.actor, task.id, { baseVersion: 0, idempotencyKey: k });
    expect(r2.run.id).toBe(r1.run.id);
    expect(r2.created).toBe(false);
    const t = (await store.getTask(task.id, a.orgId))!;
    await svc.updateTaskMeta(ctx, a.actor, task.id, { revision: t.revision, title: '제목 바꿈' }).catch(() => undefined);
    // 처리 중이라 입력은 못 바꾼다 — 실행을 끝낸 뒤 바꾸고 같은 번호로 다시 보내면 409
    await runWorker(ctx, { workerId: 'w', runId: r1.run.id });
    const t2 = (await store.getTask(task.id, a.orgId))!;
    await svc.updateTaskMeta(ctx, a.actor, task.id, { revision: t2.revision, title: '제목 바꿈' });
    await expect(svc.requestGenerate(ctx, a.actor, task.id, { baseVersion: 1, idempotencyKey: k })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('A12·A26 — 모델 장애는 다시 시도하고, 끝난 단계는 되풀이하지 않으며 작업자가 죽어도 이어 받는다', async () => {
    const task = await newTask();
    const r = await svc.requestGenerate(ctx, a.actor, task.id, { baseVersion: 0, idempotencyKey: key() });
    gen.failNext = 1;
    const first = await runWorker(ctx, { workerId: 'w1', runId: r.run.id });
    expect(first[0].finish).toBe('requeued');
    // 다시 시도 대기(available_at)를 지금으로 당긴다
    await pool.query('UPDATE work_runs SET available_at = now() WHERE id = $1', [r.run.id]);
    // 작업자 w2가 가져간 뒤 죽은 것처럼 — lease만 잡고 처리하지 않음
    const claimed = await store.claimRuns('w2', 120, 1, r.run.id);
    expect(claimed[0].attempt).toBe(2);
    await pool.query(`UPDATE work_runs SET lease_until = now() - interval '1 second' WHERE id = $1`, [r.run.id]);
    const done = await runWorker(ctx, { workerId: 'w3', runId: r.run.id });
    expect(done[0].finish).toBe('succeeded');
    expect(gen.calls).toBe(2); // 실패 1 + 성공 1 — 죽은 작업자 몫으로 모델을 더 부르지 않았다
    const versions = await store.listVersions(task.id, a.orgId);
    expect(versions).toHaveLength(1);
    expect((await store.listArtifacts(task.id, a.orgId))).toHaveLength(1);
    // 같은 응답을 두 번 과금하지 않는다(성공한 호출 1건만 기록)
    const usage = await pool.query(`SELECT count(*)::int AS n FROM usage_logs WHERE resource_id = $1`, [r.run.id]);
    expect(usage.rows[0].n).toBe(1);
  });

  it('A12 — 판을 저장한 뒤 체크포인트 전에 죽어도 같은 실행이 판을 두 번 만들지 않는다', async () => {
    const task = await newTask();
    const r = await svc.requestGenerate(ctx, a.actor, task.id, { baseVersion: 0, idempotencyKey: key() });
    const realSaveStep = store.saveStep.bind(store);
    let crashed = false;
    const crashing: WorkStore = {
      ...store,
      async saveStep(runId, org, step, attempt, status, output, err) {
        if (!crashed && step === 'save_version' && status === 'succeeded') {
          crashed = true;
          throw new Error('작업자 프로세스 죽음(가정)');
        }
        return realSaveStep(runId, org, step, attempt, status, output, err);
      },
    };
    const res1 = await runWorker({ ...ctx, store: crashing }, { workerId: 'w1', runId: r.run.id });
    expect(res1[0].finish).toBe('requeued');
    await pool.query('UPDATE work_runs SET available_at = now() WHERE id = $1', [r.run.id]);
    const res2 = await runWorker(ctx, { workerId: 'w2', runId: r.run.id });
    expect(res2[0].finish).toBe('succeeded');
    expect(await store.listVersions(task.id, a.orgId)).toHaveLength(1);
    expect(gen.calls).toBe(1);
  });

  it('A13 — 파일은 올렸는데 기록이 실패하면 올린 객체를 지우고 성공으로 바꾸지 않는다', async () => {
    const task = await newTask();
    const r = await svc.requestGenerate(ctx, a.actor, task.id, { baseVersion: 0, idempotencyKey: key() });
    const failing: WorkStore = { ...store, insertArtifact: async () => { throw new Error('DB 끊김'); } };
    const res = await runWorker({ ...ctx, store: failing }, { workerId: 'w1', runId: r.run.id });
    expect(res[0].finish).toBe('requeued');
    const v = (await store.listVersions(task.id, a.orgId))[0];
    const art = path.join(filesRoot, 'work', a.orgId, task.id, 'artifacts', `${v.id}-letter.hwpx`);
    expect(await ctx.files.size(path.relative(filesRoot, art).split(path.sep).join('/'))).toBeNull();
    expect(await store.listArtifacts(task.id, a.orgId)).toHaveLength(0);
    await pool.query('UPDATE work_runs SET available_at = now() WHERE id = $1', [r.run.id]);
    expect((await runWorker(ctx, { workerId: 'w2', runId: r.run.id }))[0].finish).toBe('succeeded');
    expect(await store.listArtifacts(task.id, a.orgId)).toHaveLength(1);
  });

  async function generated() {
    const task = await newTask();
    const r = await svc.requestGenerate(ctx, a.actor, task.id, { baseVersion: 0, idempotencyKey: key() });
    await runWorker(ctx, { workerId: 'w', runId: r.run.id });
    return task;
  }

  it('A08 — 두 화면이 같은 판을 고치면 늦은 저장은 409(최근 판을 덮지 않음)', async () => {
    const task = await generated();
    const d = await svc.getTaskDetail(ctx, a.actor, task.id);
    const body = d.version!.fields.find((f) => f.label === '본문')!;
    const s1 = await svc.saveDocument(ctx, a.actor, task.id, { baseVersion: 1, patches: [{ fieldId: body.id, operation: 'set_value', value: '화면 1의 본문' }] });
    expect(s1.version?.version).toBe(2);
    await expect(
      svc.saveDocument(ctx, a.actor, task.id, { baseVersion: 1, patches: [{ fieldId: body.id, operation: 'set_value', value: '화면 2의 본문' }] })
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT', details: { currentVersion: 2 } });
    // 새 판의 파일이 만들어지고 1판 파일은 그대로
    await runWorker(ctx, { workerId: 'w', runId: s1.run!.id });
    const versions = await svc.listVersions(ctx, a.actor, task.id);
    expect(versions.map((v) => [v.version, v.artifacts.length])).toEqual([
      [2, 1],
      [1, 1],
    ]);
    const v2art = (await store.getArtifact(versions[0].artifacts[0].id, a.orgId))!;
    const check = await checkPackage((await ctx.files.get(v2art.storage_path))!, { format: 'hwpx', values: ['화면 1의 본문'] });
    expect(check.valid).toBe(true);
  });

  it('A07 — AI 수정은 고른 칸만 바꾸고 잠긴 칸·직원이 고친 칸은 그대로', async () => {
    const task = await generated();
    const d = await svc.getTaskDetail(ctx, a.actor, task.id);
    const f = (l: string) => d.version!.fields.find((x) => x.label === l)!;
    const s = await svc.saveDocument(ctx, a.actor, task.id, {
      baseVersion: 1,
      patches: [
        { fieldId: f('붙임').id, operation: 'set_lock', value: true },
        { fieldId: f('제목').id, operation: 'set_value', value: '직원이 고친 제목' },
      ],
    });
    const req = await svc.requestRevision(ctx, a.actor, task.id, { baseVersion: 2, fieldIds: [f('본문').id, f('붙임').id], instruction: '핵심만 3줄로', idempotencyKey: key() });
    // 이 시험의 실행만 처리한다(다른 시험이 남긴 대기 실행을 집지 않게)
    await runWorker(ctx, { workerId: 'w', runId: s.run!.id });
    await runWorker(ctx, { workerId: 'w', runId: req.run.id });
    const prop = await svc.getProposal(ctx, a.actor, task.id, req.proposalId);
    expect(prop.run).toMatchObject({ status: 'succeeded' });
    expect(prop.status).toBe('ready');
    expect(prop.changes.map((c) => c.fieldId)).toEqual([f('본문').id]);
    const applied = await svc.applyProposal(ctx, a.actor, task.id, req.proposalId, { baseVersion: 2 });
    expect(applied.version.version).toBe(3);
    const after = await svc.getTaskDetail(ctx, a.actor, task.id);
    const g = (l: string) => after.version!.fields.find((x) => x.label === l)!;
    expect(g('본문').value).toMatch(/핵심만 3줄로/);
    expect(g('붙임').value).toBe(f('붙임').value);
    expect(g('제목').value).toBe('직원이 고친 제목');
    expect(s.version?.version).toBe(2);
    // 같은 후보를 두 번 적용하지 않는다
    await expect(svc.applyProposal(ctx, a.actor, task.id, req.proposalId, { baseVersion: 3 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('A09 — 복구는 과거 내용으로 새 판을 만들고 과거 판·파일은 그대로 둔다', async () => {
    const task = await generated();
    const d = await svc.getTaskDetail(ctx, a.actor, task.id);
    const body = d.version!.fields.find((f) => f.label === '본문')!;
    const s = await svc.saveDocument(ctx, a.actor, task.id, { baseVersion: 1, patches: [{ fieldId: body.id, operation: 'set_value', value: '바꾼 본문' }] });
    // 저장이 건 '이 판의 파일 만들기'는 작업 상세에 보여야 화면을 다시 열어도 처리를 이어 건다(로그인 화면 확인에서 찾은 빈틈)
    const pending = await svc.getTaskDetail(ctx, a.actor, task.id);
    expect(pending.run).toMatchObject({ id: s.run!.id, operation: 'package', status: 'queued' });
    await runWorker(ctx, { workerId: 'w', runId: s.run!.id });
    expect((await svc.getTaskDetail(ctx, a.actor, task.id)).run?.id).not.toBe(s.run!.id);
    const r = await svc.restoreVersion(ctx, a.actor, task.id, d.version!.id, { baseVersion: 2 });
    await runWorker(ctx, { workerId: 'w', runId: r.run.id });
    const versions = await svc.listVersions(ctx, a.actor, task.id);
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
    const v3 = await store.getVersion(versions[0].id, a.orgId);
    expect((v3!.fields as { label: string; value: string }[]).find((f) => f.label === '본문')!.value).toBe(body.value);
    expect(versions[2].artifacts[0].sha256).toBe(d.currentArtifacts[0].sha256);
  });

  it('검토 완료 — 막는 사항이 남으면 거절, 고친 뒤 지금 판으로만 완료, 오래된 판 승인은 409', async () => {
    const task = await generated();
    const d = await svc.getTaskDetail(ctx, a.actor, task.id);
    await expect(svc.reviewTask(ctx, a.actor, task.id, { action: 'approve', versionId: d.version!.id })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const sender = d.version!.fields.find((f) => f.label === '발신명의')!;
    const s = await svc.saveDocument(ctx, a.actor, task.id, { baseVersion: 1, patches: [{ fieldId: sender.id, operation: 'set_value', value: '가상기관A 이사장' }] });
    await expect(svc.reviewTask(ctx, a.actor, task.id, { action: 'approve', versionId: d.version!.id })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    // 파일이 아직 없으면 완료할 수 없다
    await expect(svc.reviewTask(ctx, a.actor, task.id, { action: 'approve', versionId: s.version!.id })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await runWorker(ctx, { workerId: 'w', runId: s.run!.id });
    const ok = await svc.reviewTask(ctx, a.actor, task.id, { action: 'approve', versionId: s.version!.id });
    expect(ok.status).toBe('completed');
  });

  it('A21·A22 — 다른 기관·같은 기관 관리자·다른 사용자는 작업·파일을 못 보고, 명시적 구성원만 역할대로', async () => {
    const task = await generated();
    const d = await svc.getTaskDetail(ctx, a.actor, task.id);
    const artId = d.currentArtifacts[0].id;
    await expect(svc.getTaskDetail(ctx, b.actor, task.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(svc.artifactDownloadUrl(ctx, b.actor, artId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const admin = await addUser(a, true);
    await expect(svc.getTaskDetail(ctx, admin, task.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(svc.artifactDownloadUrl(ctx, admin, artId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await svc.listTasks(ctx, admin, {})).items).toHaveLength(0);

    const viewer = await addUser(a);
    await store.addMember(task.id, a.orgId, viewer.userId, 'viewer', a.userId);
    expect((await svc.getTaskDetail(ctx, viewer, task.id)).task.id).toBe(task.id);
    expect(await svc.artifactDownloadUrl(ctx, viewer, artId)).toMatch(/^local:\/\//);
    const body = d.version!.fields[0];
    await expect(svc.saveDocument(ctx, viewer, task.id, { baseVersion: 1, patches: [{ fieldId: body.id, operation: 'set_value', value: 'x' }] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await svc.listTasks(ctx, viewer, {})).items.map((t) => t.id)).toEqual([task.id]);
  });

  it('A20 — 대화를 지워도 새 업무 결과물은 그대로다(대화와 묶이지 않음)', async () => {
    const task = await generated();
    const conv = randomUUID();
    await pool.query('INSERT INTO conversations (id, department_id, user_id, title) VALUES ($1, $2, $3, $4)', [conv, a.deptId, a.userId, '대화']);
    await pool.query('DELETE FROM conversations WHERE user_id = $1', [a.userId]);
    const d = await svc.getTaskDetail(ctx, a.actor, task.id);
    expect(d.currentArtifacts).toHaveLength(1);
    expect(await svc.artifactDownloadUrl(ctx, a.actor, d.currentArtifacts[0].id)).toMatch(/^local:\/\//);
  });

  it('실패 뒤에도 입력·판은 남고, 취소는 대기 중이면 바로·실행 중이면 요청만', async () => {
    const task = await newTask();
    const r = await svc.requestGenerate(ctx, a.actor, task.id, { baseVersion: 0, idempotencyKey: key() });
    const c = await svc.cancelRun(ctx, a.actor, task.id, r.run.id);
    expect(c).toMatchObject({ canceled: true, requested: true });
    expect((await store.getTask(task.id, a.orgId))!.status).toBe('ready');
    expect(await runWorker(ctx, { workerId: 'w', runId: r.run.id })).toHaveLength(0);
    expect((await store.getTask(task.id, a.orgId))!.form).toMatchObject({ facts: letterForm.facts });
  });

  it('양식 파일이 판과 달라지면(sha256 불일치) 다른 양식으로 채우지 않는다', async () => {
    const task = await newTask();
    await pool.query(`UPDATE work_template_versions SET sha256 = repeat('0', 64) WHERE id = $1`, [task.template_version_id]);
    try {
      const r = await svc.requestGenerate(ctx, a.actor, task.id, { baseVersion: 0, idempotencyKey: key() });
      const res = await runWorker(ctx, { workerId: 'w', runId: r.run.id });
      expect(res[0]).toMatchObject({ finish: 'failed', error: { code: 'TEMPLATE_MISSING' } });
    } finally {
      // 다른 시험이 같은 표준 양식 판을 쓰므로 되돌린다
      const bytes = (await import('fs')).readFileSync(path.join(process.cwd(), 'assets', 'templates', 'official_letter.hwpx'));
      await pool.query('UPDATE work_template_versions SET sha256 = $2 WHERE id = $1', [task.template_version_id, createHash('sha256').update(bytes).digest('hex')]);
    }
  });

  it('만든 HWPX는 zip·mimetype·section이 있는 진짜 패키지다(확장자만 바꾼 글이 아님)', async () => {
    const task = await generated();
    const d = await svc.getTaskDetail(ctx, a.actor, task.id);
    const row = (await store.getArtifact(d.currentArtifacts[0].id, a.orgId))!;
    const zip = await JSZip.loadAsync((await ctx.files.get(row.storage_path))!);
    expect((await zip.file('mimetype')!.async('string')).trim()).toBe('application/hwp+zip');
    expect(Object.keys(zip.files).some((n) => /^Contents\/section\d+\.xml$/.test(n))).toBe(true);
    expect(Object.keys(zip.files).some((n) => /^BinData\/.*\.(png|jpg|bmp)$/i.test(n) && n.includes('page'))).toBe(false);
  });
});
