import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import ExcelJS from 'exceljs';
import { createPgWorkStore } from '@/lib/work/store/pg';
import { createLocalWorkFiles } from '@/lib/work/files';
import { unavailableRenderer } from '@/lib/work/documents/renderer';
import { mockGenerator } from '@/lib/work/generation/compose';
import { confirmSource, createSourceUpload } from '@/lib/work/sources';
import type { WorkContext } from '@/lib/work/context';
import type { WorkActor } from '@/lib/work/types';
import * as svc from '@/lib/work/services';
import { runWorker } from '@/lib/work/runs/worker';
import { fixture, fixtureWorkbooks } from './helpers/quarterly-fixture';

/**
 * 자료 취합 흐름 — 실제 XLSX 원자료 4개(중복 사본 포함)를 올려 실제 Postgres·실행기로 통합 엑셀을 만든다.
 * 08 문서 '분기 실적 통합 과제' 2~6·9(XLSX 수치), A14. WORK_TEST_DATABASE_URL이 있을 때만.
 */
const url = process.env.WORK_TEST_DATABASE_URL;

describe.skipIf(!url)('자료 취합 흐름(실제 Postgres·실제 XLSX)', () => {
  let pool: pg.Pool;
  let ctx: WorkContext;
  let actor: WorkActor;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 3 });
    ctx = {
      store: createPgWorkStore(pool),
      files: createLocalWorkFiles(mkdtempSync(path.join(tmpdir(), 'workon-coll-'))),
      generator: mockGenerator,
      generatorMode: 'llm',
      renderer: unavailableRenderer,
      resolveModel: async () => 'claude-sonnet-4-6',
      checkLimit: async () => ({ allowed: true }),
      log: async () => undefined,
      now: () => new Date(),
    };
    const orgId = randomUUID(), deptId = randomUUID(), userId = randomUUID();
    await pool.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, '가상공공지원재단']);
    await pool.query('INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, $2, $3, $4)', [deptId, '기획팀', `d-${deptId.slice(0, 8)}`, orgId]);
    await pool.query('INSERT INTO users (id, email, department_id) VALUES ($1, $2, $3)', [userId, `${userId}@test.local`, deptId]);
    await pool.query('INSERT INTO work_org_settings (organization_id, home_enabled, new_tasks_enabled) VALUES ($1, true, true)', [orgId]);
    actor = { userId, organizationId: orgId, departmentId: deptId, isAdmin: false, managedDepartmentIds: [] };
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('원자료 올리기 → 취합 → 잠정 승인 → 기대 수치의 통합 XLSX(값만, 원본 대응·제출 현황)', async () => {
    const task = await svc.createTask(ctx, actor, {
      workflowKey: 'collection',
      title: '2026년 3분기 사업 실적 취합',
      form: { expectedDepartments: fixture.expectedDepartments, period: '2026년 3분기', fieldDefinitions: [{ name: '예산액' }, { name: '집행액' }, { name: '참여자 수' }, { name: '집행률' }] },
    });
    expect(task.template_version_id).toBeNull();
    expect(task.status).toBe('draft'); // 원자료가 아직 없다
    await expect(svc.requestGenerate(ctx, actor, task.id, { baseVersion: 0, idempotencyKey: `k-${randomUUID()}` })).rejects.toMatchObject({ code: 'REQUIRED_INPUT_MISSING' });

    for (const f of await fixtureWorkbooks()) {
      const up = await createSourceUpload(ctx, task, actor.userId, { fileName: f.fileName, size: f.bytes.length, purpose: 'data' });
      await ctx.files.put(up.path, f.bytes, 'application/octet-stream'); // 브라우저가 서명 주소로 올리는 자리
      const src = await confirmSource(ctx, task, up.sourceId);
      expect(src.status).toBe('ready');
    }
    await svc.refreshReadiness(ctx, (await ctx.store.getTask(task.id, actor.organizationId))!);
    expect((await ctx.store.getTask(task.id, actor.organizationId))!.status).toBe('ready');

    // 1차 — 결정 없이: 미제출 때문에 막는 사항, 중복 사본 제외
    const r1 = await svc.requestGenerate(ctx, actor, task.id, { baseVersion: 0, idempotencyKey: `k-${randomUUID()}` });
    expect((await runWorker(ctx, { workerId: 'w', runId: r1.run.id }))[0].finish).toBe('succeeded');
    const d1 = await svc.getTaskDetail(ctx, actor, task.id);
    expect(d1.kind).toBe('collection');
    expect(d1.review.find((i) => i.code === 'MISSING_DEPARTMENT')?.severity).toBe('blocking');
    expect(d1.review.some((i) => i.code === 'DUPLICATE_CANDIDATE')).toBe(true);
    await expect(svc.reviewTask(ctx, actor, task.id, { action: 'approve', versionId: d1.version!.id })).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    // 2차 — 직원이 잠정 집계로 쓰기로 확인
    const r2 = await svc.requestGenerate(ctx, actor, task.id, { baseVersion: 1, idempotencyKey: `k-${randomUUID()}`, decisions: { allowProvisional: true } });
    expect((await runWorker(ctx, { workerId: 'w', runId: r2.run.id }))[0].finish).toBe('succeeded');
    const d2 = await svc.getTaskDetail(ctx, actor, task.id);
    expect(d2.version!.version).toBe(2);
    const result = d2.version!.collection as { totals: Record<string, number>; provisional: boolean };
    expect(result.totals['예산액']).toBe(2_600_000);
    expect(result.totals['집행액']).toBe(1_850_000);
    expect(result.totals['참여자 수']).toBe(62);
    expect(d2.review.filter((i) => i.severity === 'blocking' && i.state === 'open')).toEqual([]);

    // 실제 XLSX를 열어 수치·잠정 표시·수식 없음을 본다
    const art = d2.currentArtifacts[0];
    expect(art).toMatchObject({ format: 'xlsx', validation_status: 'valid' });
    const row = (await ctx.store.getArtifact(art.id, actor.organizationId))!;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await ctx.files.get(row.storage_path))! as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['결과', '제출 현황', '원본 대응', '확인 사항', '계산 근거']);
    const ws = wb.getWorksheet('결과')!;
    expect(String(ws.getCell('A2').value)).toBe('미제출 부서를 제외한 잠정 집계');
    const totalRow = ws.getRow(4 + fixture.expectedDepartments.length);
    expect(totalRow.getCell(1).value).toBe('합계(잠정)');
    expect(totalRow.getCell(3).value).toBe(2_600_000);
    expect(totalRow.getCell(4).value).toBe(1_850_000);
    expect(totalRow.getCell(5).value).toBe(62);
    expect(Number(totalRow.getCell(6).value).toFixed(2)).toBe(fixture.expectedAfterReview.executionRatePercentDisplay);
    let formulas = 0;
    wb.eachSheet((sheet) => sheet.eachRow((r) => r.eachCell((c) => { if (c.formula || (typeof c.value === 'object' && c.value && 'formula' in c.value)) formulas++; })));
    expect(formulas).toBe(0);
    const status = wb.getWorksheet('제출 현황')!;
    const statusText: string[] = [];
    status.eachRow((r) => statusText.push(r.values!.toString()));
    expect(statusText.join('\n')).toMatch(/중복 후보\(합산 안 함\)/);
    expect(statusText.join('\n')).toMatch(/운영팀.*미제출/);

    // 검토 완료 — 막는 사항 없음·지금 판의 엑셀이 있음
    expect((await svc.reviewTask(ctx, actor, task.id, { action: 'approve', versionId: d2.version!.id })).status).toBe('completed');
  });
});
