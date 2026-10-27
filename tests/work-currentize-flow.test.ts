import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
import type { WorkActor, WorkTaskRow } from '@/lib/work/types';
import type { RegulationProviders } from '@/lib/work/workflows/regulations/gather';
import type { RawEvidence } from '@/lib/work/workflows/regulations/evidence';
import { mockRegulationModel } from '@/lib/work/workflows/regulations/model';
import { mockCurrentizeModel, type CurrentizeModel, type RewriteInput } from '@/lib/work/workflows/currentize/model';
import type { CurrentizeContent } from '@/lib/work/workflows/currentize/plan';
import { readSegments } from '@/lib/work/workflows/currentize/segments';
import { readHwpxTables } from '@/lib/attachments/tables-hwpx';
import * as svc from '@/lib/work/services';
import { runWorker } from '@/lib/work/runs/worker';
import { rewriteStepName } from '@/lib/work/runs/currentize-op';
import { priorFixture } from './helpers/prior-fixture';
import { para, tableAt } from './fixtures/hwpx';
import { buildHwp, para as hwpPara } from './fixtures/hwp5';

/**
 * 현행화 흐름(S6-1) — 실제 서비스·실행기·Postgres(0034)·실제 보고서 양식으로 만든 작년 HWPX·실제 XLSX.
 * 모델(시험 모드 또는 가짜)과 법령 제공자만 가짜다.
 */
const url = process.env.WORK_TEST_DATABASE_URL;
const key = () => `k-${randomUUID()}`;

const PROSE = '2025년 예산은 1,200백만원이다. 「지방공기업법」 제64조에 따라 편성한다.';
const PROGRESS = '상반기에는 관계 기관과 협의를 거쳐 세부 추진 방향을 정하고 현장 점검을 실시하였으며 하반기에는 지원 대상을 선정하였다.';
// 사업 B는 작년 전년도·증감 칸이 비었다(글 없는 칸 — 조각이 없어 글자 단위로 고칠 수 없다)
const TABLE =
  para('(단위: 백만원)') +
  tableAt([['구분', '2024년', '2025년', '증감'], ['사업 A', '1,100', '1,200', '100'], ['사업 B', '', '500', '']], { addr: true });

const lawText = (): RawEvidence => ({
  kind: 'law',
  title: '지방공기업법',
  location: '제64조(예산)',
  effectiveDate: '2020-01-01',
  editionYear: null,
  issuer: null,
  text: '제64조(예산) 지방공기업은 매 사업연도 예산을 편성한다.',
  url: null,
});

const providers: RegulationProviders = {
  orgDocuments: async () => ({ status: 'ok', items: [] }),
  common: async () => ({ status: 'ok', items: [] }),
  laws: async () => ({ status: 'ok', items: [lawText()] }),
};

/** 원가 상한 시험용 — 부르면 센다(불리면 안 된다) */
class CountingModel implements CurrentizeModel {
  calls = 0;
  async rewrite(input: RewriteInput) {
    this.calls += 1;
    return { rewrites: input.segments.slice(0, 1).map((s) => ({ segmentId: s.id, text: s.text, basis: ['memo'] })), usage: { model: 'claude-sonnet-4-6', input_tokens: 5000, output_tokens: 2000 }, mode: 'llm' as const };
  }
}

async function dataWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('2026');
  ws.addRow(['구분', '2026년(백만원)']);
  ws.addRow(['사업 A', 1300]);
  ws.addRow(['사업 B', 600]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('현행화 묶음 단계 이름', () => {
  it('DB가 받는 꼴(영소문자·밑줄)이고 순번마다 다르다', () => {
    const names = Array.from({ length: 200 }, (_, i) => rewriteStepName(i));
    expect(names.slice(0, 3)).toEqual(['rewrite_a', 'rewrite_b', 'rewrite_c']);
    expect(rewriteStepName(26)).toBe('rewrite_ba');
    expect(names.every((n) => /^[a-z_]{1,40}$/.test(n))).toBe(true);
    expect(new Set(names).size).toBe(200);
  });
});

describe.skipIf(!url)('현행화 흐름(실제 Postgres·실제 파일)', () => {
  let pool: pg.Pool;
  let ctx: WorkContext;
  let actor: WorkActor;
  const filesRoot = mkdtempSync(path.join(tmpdir(), 'workon-cur-'));

  async function upload(task: WorkTaskRow, name: string, bytes: Buffer, purpose: string) {
    const up = await createSourceUpload(ctx, task, actor.userId, { fileName: name, size: bytes.length, purpose });
    await ctx.files.put(up.path, bytes, 'application/octet-stream');
    expect((await confirmSource(ctx, task, up.sourceId)).status).toBe('ready');
    await svc.refreshReadiness(ctx, (await ctx.store.getTask(task.id, actor.organizationId))!);
    return (await ctx.store.getTask(task.id, actor.organizationId))!;
  }

  async function run(task: WorkTaskRow) {
    const r = await svc.requestGenerate(ctx, actor, task.id, { baseVersion: 0, idempotencyKey: key() });
    return (await runWorker(ctx, { workerId: 'w', runId: r.run.id }))[0];
  }

  async function generate(task: WorkTaskRow) {
    expect(await run(task)).toMatchObject({ finish: 'succeeded' });
    return svc.getTaskDetail(ctx, actor, task.id);
  }

  async function contentOf(versionId: string) {
    return ((await ctx.store.getVersion(versionId, actor.organizationId))!.content as { currentize?: CurrentizeContent } | null)?.currentize;
  }

  const fileOf = async (id: string) => (await ctx.files.get((await ctx.store.getArtifact(id, actor.organizationId))!.storage_path))!;

  async function reportTask(title: string) {
    return svc.createTask(ctx, actor, { workflowKey: 'report', title, form: { reportType: '사업계획', period: '2026년' } });
  }

  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    pool = new pg.Pool({ connectionString: url, max: 4 });
    const orgId = randomUUID(), deptId = randomUUID(), userId = randomUUID();
    await pool.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, '가상공사']);
    await pool.query('INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, $2, $3, $4)', [deptId, '기획예산팀', `d-${deptId.slice(0, 8)}`, orgId]);
    await pool.query('INSERT INTO users (id, email, department_id) VALUES ($1, $2, $3)', [userId, `${userId}@test.local`, deptId]);
    await pool.query('INSERT INTO work_org_settings (organization_id, home_enabled, new_tasks_enabled) VALUES ($1, true, true)', [orgId]);
    actor = { userId, organizationId: orgId, departmentId: deptId, isAdmin: false, managedDepartmentIds: [] };
  });
  beforeEach(() => {
    ctx = {
      store: createPgWorkStore(pool),
      files: createLocalWorkFiles(filesRoot),
      generator: mockGenerator,
      generatorMode: 'llm',
      renderer: unavailableRenderer,
      regulations: { providers, model: mockRegulationModel },
      currentize: { model: mockCurrentizeModel },
      resolveModel: async () => 'claude-sonnet-4-6',
      checkLimit: async () => ({ allowed: true }),
      log: async (p) => { if (p.level === 'error') console.error('[work-log]', JSON.stringify(p.details)); },
      // 원자료 확인 창(10분)이 실제 시각을 보므로 실제 시각 — 올해(2026)는 폼의 대상 기간이 정한다
      now: () => new Date(),
    };
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('report + prior(2025 보고서) + data(2026 수치) → 2026 HWPX와 변경 내역표', async () => {
    let task = await reportTask('2026년 ○○ 사업계획');
    const prior = await priorFixture({ 제목: '2025년 ○○ 사업계획', '추진 경과': PROGRESS, '주요 내용': PROSE }, { appendXml: TABLE });
    task = await upload(task, '2025 사업계획.hwpx', prior, 'prior');
    task = await upload(task, '2026 예산.xlsx', await dataWorkbook(), 'data');
    expect(task.status).toBe('ready');

    const d = await generate(task);
    expect(d.version!.fields).toEqual([]);
    const c = (await contentOf(d.version!.id))!;
    // 단계 체크포인트 — 모델 묶음은 rewrite_<순번 글자>(DB가 단계 이름에 영소문자·밑줄만 받는다)
    const steps = await pool.query('SELECT s.step FROM work_run_steps s JOIN work_runs r ON r.id = s.run_id WHERE r.task_id = $1', [task.id]);
    expect(steps.rows.map((r) => r.step).sort()).toEqual(['classify', 'evidence', 'file', 'load_prior', 'review', 'rewrite_a', 'save_version', 'segments']);
    expect(c.schema).toBe('currentize/1');
    expect(c.fromYear).toBe(2025);
    expect(c.toYear).toBe(2026);
    expect(c.mode).toBe('mock');
    expect(c.costStopped).toBe(false);
    expect(c.changes.find((x) => x.kind === 'year' && x.before.includes('2025년 ○○'))).toMatchObject({ status: 'changed', after: expect.stringContaining('2026년 ○○') });
    // 본문 수치는 안 바꾼다 — 올해 자료에 없는 1,200은 사람이 본다(Review Focus 2)
    expect(c.changes.find((x) => x.kind === 'number' && x.before.includes('1,200'))).toMatchObject({ status: 'needs_check', after: null });
    expect(c.citations).toHaveLength(1);
    expect(c.citations[0].status).toBe('same');

    const hwpx = await fileOf(d.currentArtifacts.find((a) => a.format === 'hwpx')!.id);
    const out = await readSegments(hwpx);
    expect(out.segments.some((s) => s.text.includes('2026년 ○○ 사업계획'))).toBe(true);
    expect(out.segments.some((s) => s.text === PROSE.replace('2025년', '2026년'))).toBe(true);
    // 표: 열 머리가 한 해씩 밀리고, 전년도 칸 ← 옛 당해, 당해 칸 ← 올해 자료(1,300), 증감 다시 계산
    const [t] = (await readHwpxTables(hwpx)).tables;
    expect(t.cells).toEqual([
      ['구분', '2025년', '2026년', '증감'],
      ['사업 A', '1,200', '1,300', '100'],
      ['사업 B', null, '600', null],
    ]);
    // 빈 칸에 들어갈 값(전년도 500·증감 100)은 같은 행 첫 조각('사업 B')에 구조 확인 요청으로 붙는다
    const rowB = (await readSegments(prior)).segments.find((s) => s.text === '사업 B')!;
    const blank = c.changes.filter((x) => x.kind === 'structure');
    expect(blank.map((x) => [x.segmentId, x.status, x.before, x.after, x.note])).toEqual([
      [rowB.id, 'needs_check', '', '500', '빈 칸에 값을 넣어야 합니다 — 직접 입력하세요'],
      [rowB.id, 'needs_check', '', '100', '빈 칸에 값을 넣어야 합니다 — 직접 입력하세요'],
    ]);
    // 값이 그대로인 칸(증감 100 → 100)은 변경으로 세지 않는다
    expect(c.changes.filter((x) => x.kind === 'table').map((x) => [x.before, x.after])).toEqual([['1,100', '1,200'], ['1,200', '1,300'], ['500', '600']]);

    expect(d.review.some((r) => r.code === 'NEEDS_CHECK')).toBe(true);
    expect(d.review.some((r) => r.code === 'TEST_MODE')).toBe(true);
    expect(d.review.some((r) => r.code === 'INCOMPLETE')).toBe(false);

    const xlsx = d.currentArtifacts.find((a) => a.format === 'xlsx');
    expect(xlsx).toMatchObject({ output_key: 'changeLog', validation_status: 'valid' });
    expect(d.currentArtifacts.map((a) => a.output_key)).toEqual(['report', 'changeLog']);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await fileOf(xlsx!.id)) as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet('변경 내역')!;
    expect(sheet.rowCount).toBe(c.changes.length + 1);
    // 시험 모드 — 모델을 부르지 않았으니 사용 기록이 없다
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM usage_logs WHERE details->>'task_id' = $1", [task.id]);
    expect(rows[0].n).toBe(0);
  });

  it('prior가 HWP 5.0이면 TEMPLATE_UNSUPPORTED가 아니라 PRIOR_UNSUPPORTED로 실패하고 작년 파일·입력은 남는다', async () => {
    let task = await reportTask('옛 한글 작년 파일');
    task = await upload(task, '2025 사업계획.hwp', buildHwp(hwpPara('2025년 사업계획')), 'prior');
    task = await upload(task, '2026 예산.xlsx', await dataWorkbook(), 'data');
    expect(task.status).toBe('ready');
    const outcome = await run(task);
    expect(outcome.finish).toBe('failed');
    expect(outcome.error).toMatchObject({ code: 'PRIOR_UNSUPPORTED', retryable: false });
    expect(outcome.error!.safeMessage).toContain('HWPX');
    const after = (await ctx.store.getTask(task.id, actor.organizationId))!;
    expect(after.status).toBe('ready');
    expect(after.current_document_version_id).toBeNull();
    const sources = await ctx.store.listSources(task.id, actor.organizationId);
    expect(sources.filter((s) => s.status === 'ready').map((s) => s.purpose).sort()).toEqual(['data', 'prior']);
  });

  it('원가 상한을 1원으로 두면 첫 묶음 전에 멈추고 INCOMPLETE 검토 항목과 costStopped가 남는다', async () => {
    const model = new CountingModel();
    ctx.currentize = { model };
    ctx.costCapKrw = 1;
    let task = await reportTask('원가 상한');
    const prior = await priorFixture({ 제목: '2025년 ○○ 사업계획', '추진 경과': PROGRESS, '주요 내용': PROSE }, { appendXml: TABLE });
    task = await upload(task, '2025 사업계획.hwpx', prior, 'prior');
    task = await upload(task, '2026 예산.xlsx', await dataWorkbook(), 'data');
    task = await upload(task, '추진 현황.txt', Buffer.from('사업 추진 현황을 정리한 자료이다. '.repeat(120), 'utf8'), 'reference');

    const d = await generate(task);
    expect(model.calls).toBe(0);
    const c = (await contentOf(d.version!.id))!;
    expect(c.costStopped).toBe(true);
    expect(c.changes.find((x) => x.before === PROGRESS)).toMatchObject({ kind: 'prose', status: 'needs_check', note: '원가 상한으로 멈춤 — 나머지 문장은 직접 확인하세요' });
    expect(d.review.find((r) => r.code === 'INCOMPLETE')).toMatchObject({ severity: 'blocking' });
    // 연도·표처럼 프로그램이 정하는 변경은 그대로 들어간다(반쯤 바뀐 파일은 INCOMPLETE로 '완료'를 막는다)
    expect(c.changes.some((x) => x.kind === 'year' && x.status === 'changed')).toBe(true);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM usage_logs WHERE details->>'task_id' = $1", [task.id]);
    expect(rows[0].n).toBe(0);
  });

  it('prior가 없는 report는 지금처럼 양식 채우기(document) 경로다', async () => {
    let task = await reportTask('작년 파일 없는 보고서');
    task = await upload(task, '2026 예산.xlsx', await dataWorkbook(), 'data');
    expect(task.status).toBe('ready');
    const d = await generate(task);
    expect(d.version!.fields.length).toBeGreaterThan(0);
    expect(await contentOf(d.version!.id)).toBeUndefined();
    expect((await ctx.store.getVersion(d.version!.id, actor.organizationId))!.template_version_id).toBe(task.template_version_id);
    expect(d.currentArtifacts.map((a) => [a.output_key, a.format])).toEqual([['report', 'hwpx']]);
  });
});
