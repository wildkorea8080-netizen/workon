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
import { WorkError, type WorkActor, type WorkTaskRow } from '@/lib/work/types';
import type { RegulationProviders } from '@/lib/work/workflows/regulations/gather';
import type { RawEvidence } from '@/lib/work/workflows/regulations/evidence';
import { mockRegulationModel } from '@/lib/work/workflows/regulations/model';
import { mockCurrentizeModel, type CurrentizeModel, type RewriteInput } from '@/lib/work/workflows/currentize/model';
import type { Change, CurrentizeContent } from '@/lib/work/workflows/currentize/plan';
import { currentizeReviewItems } from '@/lib/work/workflows/currentize/review';
import { readSegments } from '@/lib/work/workflows/currentize/segments';
import { readHwpxTables } from '@/lib/attachments/tables-hwpx';
import * as svc from '@/lib/work/services';
import { runWorker } from '@/lib/work/runs/worker';
import { rewriteStepName } from '@/lib/work/runs/currentize-op';
import { priorFixture } from './helpers/prior-fixture';
import { para, tableAt, sectionXml } from './fixtures/hwpx';
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
// 한글은 탭·전각 공백을 <hp:t> 안의 태그로 쓴다 — 고친 문단에 그대로 남아야 한다
const TABBED = para('○ 기간 2025년<hp:tab/>3월까지<hp:fwSpace/>추진');
const TABLE =
  TABBED +
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

/** 둘째 호출에서 한 번 던지는 모델(첫 묶음은 체크포인트, 둘째 묶음에서 실행이 다시 시도됨) */
class FlakyModel implements CurrentizeModel {
  calls = 0;
  async rewrite() {
    this.calls += 1;
    if (this.calls === 2) throw new WorkError('LLM_UNAVAILABLE', 'AI 연결이 잠시 원활하지 않습니다.', 503);
    return { rewrites: [], usage: { model: 'claude-sonnet-4-6', input_tokens: 100, output_tokens: 10 }, mode: 'llm' as const };
  }
}

/** 숫자·연도 없는 줄글 n줄(모두 prose 조각) — 묶음(50조각)을 둘로 나누려고 */
const proseLines = (n: number) => Array.from({ length: n }, (_, i) => `${String.fromCharCode(0xac00 + i * 28)} 과제는 관계 기관과 협의를 마쳤다.`);

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

describe('현행화 확인 사항', () => {
  const change = (i: number, status: Change['status']): Change => ({ id: `c${i}`, segmentId: `0:${i}`, kind: 'number', before: 'x', after: null, status, basis: [], note: `확인 ${i}` });
  const base: Omit<CurrentizeContent, 'changes'> = { schema: 'currentize/1', priorSourceId: 'p', priorSha256: 'h', fromYear: 2025, toYear: 2026, citations: [], truncated: false, costStopped: false, mode: 'llm' };
  it('확인 필요·제안은 각 20개까지만 싣고 넘으면 요약 한 줄', () => {
    const items = currentizeReviewItems({ ...base, changes: [...Array.from({ length: 25 }, (_, i) => change(i, 'needs_check')), ...Array.from({ length: 22 }, (_, i) => change(100 + i, 'proposed'))] });
    expect(items.filter((i) => i.code === 'NEEDS_CHECK')).toHaveLength(20);
    expect(items.filter((i) => i.code === 'PROPOSED')).toHaveLength(20);
    expect(items.filter((i) => i.message === '확인 필요 47건 — 변경 내역표에서 전체를 보세요')).toHaveLength(1);
  });
  it('넘지 않으면 요약이 없다', () => {
    const items = currentizeReviewItems({ ...base, changes: [change(1, 'needs_check'), change(2, 'proposed')] });
    expect(items.map((i) => i.code)).toEqual(['NEEDS_CHECK', 'PROPOSED']);
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
    // 탭·전각 공백 태그가 든 문단도 고쳐지고 태그는 제자리에 남는다(패키지 검사가 <hp:t> 속 태그 때문에 막지 않는다)
    expect(c.changes.find((x) => x.before === '○ 기간 2025년3월까지추진')).toMatchObject({ kind: 'year', status: 'changed', after: '○ 기간 2026년3월까지추진' });
    expect(await sectionXml(hwpx)).toContain('2026년<hp:tab/>3월까지<hp:fwSpace/>추진');
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

  it('대조 보기 수정: 확인 필요 변경에 올해 글을 넣으면 새 판·파일을 다시 만들고, 낡은 판·모르는 변경·빈 칸은 거절한다', async () => {
    let task = await reportTask('2026년 대조 수정');
    const prior = await priorFixture({ 제목: '2025년 ○○ 사업계획', '추진 경과': PROGRESS, '주요 내용': PROSE }, { appendXml: TABLE });
    task = await upload(task, '2025 사업계획.hwpx', prior, 'prior');
    task = await upload(task, '2026 예산.xlsx', await dataWorkbook(), 'data');
    const d1 = await generate(task);
    const c1 = d1.version!.currentize!;
    // 화면 DTO — 변경마다 사람이 읽는 위치(표 칸은 '표 N (행,열)')
    expect(c1.changes.every((x) => typeof x.location === 'string' && x.location.length > 0)).toBe(true);
    expect(c1.changes.find((x) => x.kind === 'table')!.location).toMatch(/^표 \d+ \(\d+,\d+\)$/);
    expect(c1.toYear).toBe(2026);
    expect(d1.producedOutputs).toEqual(['report', 'changeLog']);

    const number = c1.changes.find((x) => x.kind === 'number' && x.before === PROSE)!;
    expect(number.status).toBe('needs_check');
    // 같은 문단에 연도 바꿈이 이미 있다 — 직원 글이 문단 전체를 대신한다
    const sibling = c1.changes.find((x) => x.kind === 'year' && x.before === PROSE)!;
    expect(sibling.status).toBe('changed');
    const typed = '2026년 예산은 1,300백만원이다. 「지방공기업법」 제64조에 따라 편성한다.';

    // 낡은 판·모르는 변경·빈 칸·빈 글은 거절
    await expect(svc.applyChangeEdit(ctx, actor, task.id, { baseVersion: 0, changeId: number.id, after: typed })).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
    await expect(svc.applyChangeEdit(ctx, actor, task.id, { baseVersion: 1, changeId: 'c999', after: typed })).rejects.toMatchObject({ code: 'INVALID_INPUT', status: 400 });
    const structure = c1.changes.find((x) => x.kind === 'structure')!;
    await expect(svc.applyChangeEdit(ctx, actor, task.id, { baseVersion: 1, changeId: structure.id, after: '500' })).rejects.toMatchObject({ code: 'INVALID_INPUT', message: '빈 칸은 한글에서 직접 채워 주세요' });
    await expect(svc.applyChangeEdit(ctx, actor, task.id, { baseVersion: 1, changeId: number.id, after: '  \n ' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(svc.applyChangeEdit(ctx, actor, task.id, { baseVersion: 1, changeId: number.id, after: 'x'.repeat(6001) })).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const r = await svc.applyChangeEdit(ctx, actor, task.id, { baseVersion: 1, changeId: number.id, after: `${typed}  ` });
    expect(r.version!.version).toBe(2);
    expect((await runWorker(ctx, { workerId: 'w', runId: r.run!.id }))[0]).toMatchObject({ finish: 'succeeded' });

    const d2 = await svc.getTaskDetail(ctx, actor, task.id);
    expect(d2.version!.version).toBe(2);
    expect(d2.version!.origin).toBe('edit');
    expect(d2.version!.fields).toEqual([]);
    const c2 = (await contentOf(d2.version!.id))!;
    expect(c2.changes.find((x) => x.id === number.id)).toMatchObject({ status: 'changed', after: typed, basis: ['user'], note: null });
    // 같은 문단의 다른 바꿈은 직원 글에 담겼다 — 한 문단에 두 번 적용하지 않게 목록에서 뺀다
    expect(c2.changes.some((x) => x.id === sibling.id)).toBe(false);
    expect(c2.changes.filter((x) => x.segmentId === number.segmentId && x.status === 'changed')).toHaveLength(1);
    expect(c2.priorSha256).toBe(c1.priorSha256);
    // 파일 둘 다 2판으로 다시, 넣은 글이 HWPX에 있다
    expect(d2.currentArtifacts.map((a) => [a.output_key, a.document_version_id])).toEqual([['report', d2.version!.id], ['changeLog', d2.version!.id]]);
    const out = await readSegments(await fileOf(d2.currentArtifacts[0].id));
    expect(out.segments.some((s) => s.text === typed)).toBe(true);
    // 확인 사항은 2판의 변경 목록으로 다시 — 직원이 넣은 수치는 더 확인 필요가 아니다
    expect(d2.review.filter((x) => x.code === 'NEEDS_CHECK')).toHaveLength(d1.review.filter((x) => x.code === 'NEEDS_CHECK').length - 1);
    const events = await pool.query("SELECT details FROM work_events WHERE task_id = $1 AND type = 'document.edited'", [task.id]);
    expect(events.rows.map((e) => e.details)).toEqual([{ version: 2, change: number.id }]);

    // 바꿈인 변경에 같은 글을 다시 넣으면 새 판을 만들지 않는다
    expect(await svc.applyChangeEdit(ctx, actor, task.id, { baseVersion: 2, changeId: number.id, after: typed })).toMatchObject({ version: null, run: null, unchanged: true });

    // 다른 수정 길(복구)도 현행화 내용을 잃지 않는다
    const restored = await svc.restoreVersion(ctx, actor, task.id, d1.version!.id, { baseVersion: 2 });
    expect((await runWorker(ctx, { workerId: 'w', runId: restored.run.id }))[0]).toMatchObject({ finish: 'succeeded' });
    const d3 = await svc.getTaskDetail(ctx, actor, task.id);
    expect(d3.version!.currentize!.changes.find((x) => x.id === sibling.id)).toMatchObject({ status: 'changed' });
    expect(d3.currentArtifacts.map((a) => a.output_key)).toEqual(['report', 'changeLog']);
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

  it('다시 시도는 첫 시도에 고정한 원자료로 — 그 사이 올린 자료를 쓰지 않고, 끝난 묶음은 다시 부르지 않는다', async () => {
    const model = new FlakyModel();
    ctx.currentize = { model };
    let task = await reportTask('다시 시도 고정');
    const lines = ['추가 지침에 따라 세부 절차를 정비하였다.', ...proseLines(55)];
    const prior = await priorFixture({ 제목: '2025년 ○○ 사업계획', '추진 경과': lines.join(String.fromCharCode(10)), '주요 내용': PROSE }, { appendXml: TABLE });
    task = await upload(task, '2025 사업계획.hwpx', prior, 'prior');
    task = await upload(task, '2026 예산.xlsx', await dataWorkbook(), 'data');
    const r = await svc.requestGenerate(ctx, actor, task.id, { baseVersion: 0, idempotencyKey: key() });
    const first = await runWorker(ctx, { workerId: 'w', runId: r.run.id });
    expect(first[0]).toMatchObject({ finish: 'requeued', error: { code: 'LLM_UNAVAILABLE' } });
    expect(model.calls).toBe(2);
    // 실행이 기다리는 사이 직원이 참고 자료를 더 올렸다(이름이 작년 글에 있어 규정 이름으로 잡힐 수 있다)
    const extraUp = await createSourceUpload(ctx, task, actor.userId, { fileName: '추가 지침.txt', size: 30, purpose: 'reference' });
    await ctx.files.put(extraUp.path, Buffer.from('추가 지침 본문이다. 새 기준을 적용한다.', 'utf8'), 'text/plain');
    await confirmSource(ctx, task, extraUp.sourceId);
    await pool.query('UPDATE work_runs SET available_at = now() WHERE id = $1', [r.run.id]);
    expect((await runWorker(ctx, { workerId: 'w', runId: r.run.id }))[0]).toMatchObject({ finish: 'succeeded' });
    expect(model.calls).toBe(3); // 첫 묶음(rewrite_a)은 다시 부르지 않았다

    const d = await svc.getTaskDetail(ctx, actor, task.id);
    const v = (await ctx.store.getVersion(d.version!.id, actor.organizationId))!;
    expect(v.source_ids).not.toContain(extraUp.sourceId);
    const c = (v.content as { currentize: CurrentizeContent }).currentize;
    expect(c.citations.some((x) => x.cited.name.includes('추가 지침'))).toBe(false);
    expect(JSON.stringify((v.content as { currentizeWarnings: string[] }).currentizeWarnings)).not.toContain('추가 지침');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await fileOf(d.currentArtifacts.find((a) => a.output_key === 'changeLog')!.id)) as unknown as ArrayBuffer);
    const sheetText = JSON.stringify(wb.worksheets.map((ws) => ws.getSheetValues()));
    expect(sheetText).not.toContain('추가 지침.txt');
    // 묶음마다 사용 기록 한 줄(실패한 호출은 기록 없음)
    const { rows } = await pool.query("SELECT details->>'stage' AS stage FROM usage_logs WHERE details->>'task_id' = $1", [task.id]);
    expect(rows.map((x) => x.stage)).toEqual(['rewrite', 'rewrite']);
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
