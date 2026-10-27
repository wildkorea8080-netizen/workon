import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { createPgWorkStore } from '@/lib/work/store/pg';
import { createLocalWorkFiles } from '@/lib/work/files';
import { unavailableRenderer } from '@/lib/work/documents/renderer';
import { confirmSource, createSourceUpload } from '@/lib/work/sources';
import type { WorkContext } from '@/lib/work/context';
import type { FieldGenerator, ComposeInput } from '@/lib/work/generation/compose';
import type { ItemsModel, ExtractInput } from '@/lib/work/workflows/items/model';
import type { RawItem } from '@/lib/work/workflows/items/verify';
import type { WorkActor, WorkTaskRow } from '@/lib/work/types';
import * as svc from '@/lib/work/services';
import { runWorker } from '@/lib/work/runs/worker';
import { fixture, fixtureWorkbooks } from './helpers/quarterly-fixture';

/**
 * P4 흐름 — 실제 서비스·실행기·채우기 엔진·Postgres(0034)·한글로 만든 양식. 모델만 가짜.
 * 완료 기준(07 문서 P4): 가상 분기 실적 시나리오에서 접수 → 취합 → 보고서 → 제출 공문의 실제 파일들이 이어지고,
 * 보고서와 공문의 금액이 같으며 원자료까지 추적된다. 회의(A17)·인수인계(미결·기한·비밀값)도 본다.
 */
const url = process.env.WORK_TEST_DATABASE_URL;
const key = () => `k-${randomUUID()}`;

/** 업무별로 정해 둔 항목을 낸다(원문 인용은 실제 원자료 글) */
class FakeItemsModel implements ItemsModel {
  calls = 0;
  async extract(input: ExtractInput) {
    this.calls += 1;
    const src = (name: string) => input.sources.find((s) => s.name.includes(name))!.id;
    let items: RawItem[] = [];
    let meta: Record<string, string> = {};
    let summary = '';
    if (input.spec.name === '요청사항·처리표') {
      items = [
        { type: '제출', sourceId: src('공문'), quote: '2026년 3분기 사업 실적을 붙임 양식에 따라 2026. 10. 30.(금)까지 제출', values: { request: '3분기 사업 실적 제출', deliverable: '실적 제출 양식', period: '2026년 3분기', due: '2026-10-30', contact: '기획팀 주무관 김가나' } },
        { type: '제출', sourceId: src('붙임'), quote: '제출 기한: 2026. 10. 31.', values: { request: '3분기 사업 실적 제출', deliverable: '실적 제출 양식', period: '2026년 3분기', due: '2026-10-31' } },
        { type: '회신', sourceId: src('붙임'), quote: '미제출 시 사유를 접수 후 3일 이내 회신', values: { request: '미제출 사유 회신', due: '접수 후 3일 이내', contact: '총무과 박담당' } },
      ];
      meta = { sender: '가상공공지원재단', docNumber: '기획팀-1234' };
    } else if (input.spec.name === '회의 내용·후속조치') {
      items = [
        { type: '안건', sourceId: src('회의'), quote: '안건: 4분기 집행 계획', values: { content: '4분기 집행 계획' } },
        { type: '결정', sourceId: src('회의'), quote: '위원장: 집행 계획 원안 의결', values: { content: '집행 계획 원안 의결', speaker: '위원장' } },
        { type: '조건부 합의', sourceId: src('회의'), quote: '홍보 사업은 예산 범위 안에서 추진하는 조건으로 동의', values: { content: '홍보 사업 추진', condition: '예산 범위 안에서 추진' } },
        { type: '제안', sourceId: src('회의'), quote: '이위원: 교육 사업 확대 제안', values: { content: '교육 사업 확대', speaker: '이위원' } },
        { type: '미결', sourceId: src('회의'), quote: '운영팀 인력 충원은 다음 회의에서 결정', values: { content: '운영팀 인력 충원' } },
        { type: '후속조치', sourceId: src('회의'), quote: '기획팀이 11. 10.까지 수정 계획 제출', values: { content: '수정 계획 제출', owner: '기획팀', due: '2026-11-10' } },
        { type: '후속조치', sourceId: src('회의'), quote: '교육 사업 수요 조사', values: { content: '교육 사업 수요 조사', owner: '교육팀', due: '2026-11-30' } },
      ];
      meta = { place: '본관 2층 회의실', chair: '사무총장' };
    } else {
      items = [
        { type: '진행 중', sourceId: 'confirmed', quote: '3분기 실적 취합 진행 중 — 운영팀 자료 대기', values: { task: '3분기 실적 취합', status: '운영팀 자료 대기', owner: '운영팀' } },
        { type: '미결', sourceId: 'confirmed', quote: '예산 재배정 요청 미결(기한 2026. 9. 30.)', values: { task: '예산 재배정 요청', due: '2026-09-30' } },
        { type: '반복 일정', sourceId: src('매뉴얼'), quote: '매월 5일 집행 실적 시스템 입력 — 비밀번호: Qwer!2345', values: { task: '집행 실적 시스템 입력', due: '매월 5일', reference: '집행 시스템 비밀번호: Qwer!2345' } },
        { type: '완료', sourceId: src('매뉴얼'), quote: '2분기 실적 보고 완료(7. 15.)', values: { task: '2분기 실적 보고' } },
      ];
      summary = '분기 실적 취합·보고와 집행 실적 관리를 맡는 업무입니다.';
    }
    return { items, meta, summary, usage: { model: 'claude-sonnet-4-6', input_tokens: 300, output_tokens: 100 }, mode: 'llm' as const };
  }
}

/** 보고서·공문 칸 — 원자료(가져온 취합 엑셀·보고서)에 있는 금액으로 쓴다 */
class FakeGenerator implements FieldGenerator {
  wrongNumber = false;
  async compose(input: ComposeInput) {
    const values: Record<string, { value: string; evidenceIds: string[] }> = {};
    for (const f of input.fields.filter((x) => input.targetIds.includes(x.id))) {
      if (f.label === '주요 내용') values[f.id] = { value: `○ 예산 2,600,000원 중 1,850,000원 집행(집행률 71.15%)${this.wrongNumber ? '\n○ 추가 예산 3,100,000원' : ''}\n○ 참여자 62명`, evidenceIds: input.sources.map((s) => s.id) };
      else if (f.label === '본문') values[f.id] = { value: '1. 2026년 3분기 사업 실적을 보고합니다.\n2. 집행액 1,850,000원(예산 2,600,000원 대비 71.15%)', evidenceIds: [] };
      else if (f.label === '발신명의') continue;
      else values[f.id] = { value: `${f.label} 내용`, evidenceIds: [] };
    }
    return { values, missing: [], usage: { model: 'claude-sonnet-4-6', input_tokens: 200, output_tokens: 80 }, mode: 'llm' as const };
  }
}

describe.skipIf(!url)('P4 업무 연결(실제 Postgres·실제 파일)', () => {
  let pool: pg.Pool;
  let ctx: WorkContext;
  let items: FakeItemsModel;
  let gen: FakeGenerator;
  let actor: WorkActor;
  let colleague: WorkActor;

  async function addText(task: WorkTaskRow, name: string, text: string, purpose: string) {
    const bytes = Buffer.from(text, 'utf8');
    const up = await createSourceUpload(ctx, task, actor.userId, { fileName: name, size: bytes.length, purpose });
    await ctx.files.put(up.path, bytes, 'text/plain');
    const s = await confirmSource(ctx, task, up.sourceId);
    expect(s.status).toBe('ready');
    await svc.refreshReadiness(ctx, (await ctx.store.getTask(task.id, actor.organizationId))!);
  }

  async function generate(task: WorkTaskRow, decisions?: unknown) {
    const cur = await svc.getTaskDetail(ctx, actor, task.id);
    const r = await svc.requestGenerate(ctx, actor, task.id, { baseVersion: cur.version?.version ?? 0, idempotencyKey: key(), decisions });
    const out = await runWorker(ctx, { workerId: 'w', runId: r.run.id });
    expect(out[0]).toMatchObject({ finish: 'succeeded' });
    return svc.getTaskDetail(ctx, actor, task.id);
  }

  async function fileOf(artifactId: string) {
    const row = (await ctx.store.getArtifact(artifactId, actor.organizationId))!;
    return (await ctx.files.get(row.storage_path))!;
  }

  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    pool = new pg.Pool({ connectionString: url, max: 4 });
    items = new FakeItemsModel();
    gen = new FakeGenerator();
    ctx = {
      store: createPgWorkStore(pool),
      files: createLocalWorkFiles(mkdtempSync(path.join(tmpdir(), 'workon-p4-'))),
      generator: gen,
      generatorMode: 'llm',
      renderer: unavailableRenderer,
      items: { model: items },
      resolveModel: async () => 'claude-sonnet-4-6',
      checkLimit: async () => ({ allowed: true }),
      log: async (p) => { if (p.level === 'error') console.error('[work-log]', JSON.stringify(p.details)); },
      now: () => new Date('2026-10-27T01:00:00Z'),
    };
    const orgId = randomUUID(), deptId = randomUUID(), userId = randomUUID(), otherId = randomUUID();
    await pool.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, '가상공공지원재단']);
    await pool.query('INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, $2, $3, $4)', [deptId, '기획팀', `d-${deptId.slice(0, 8)}`, orgId]);
    await pool.query('INSERT INTO users (id, email, department_id) VALUES ($1, $2, $3), ($4, $5, $3)', [userId, `${userId}@test.local`, deptId, otherId, `${otherId}@test.local`]);
    await pool.query('INSERT INTO work_org_settings (organization_id, home_enabled, new_tasks_enabled) VALUES ($1, true, true)', [orgId]);
    actor = { userId, organizationId: orgId, departmentId: deptId, isAdmin: false, managedDepartmentIds: [] };
    colleague = { userId: otherId, organizationId: orgId, departmentId: deptId, isAdmin: false, managedDepartmentIds: [] };
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('완료 기준 — 접수 → 취합 → 보고서 → 제출 공문이 실제 파일로 이어지고 금액이 같으며 원자료까지 추적된다', async () => {
    // 1. 접수공문 처리 — 처리표 XLSX, 본문·붙임 기한 충돌·상대 기한·원문에 없는 문의처
    const intake = await svc.createTask(ctx, actor, { workflowKey: 'intake', title: '3분기 실적 제출 요청 접수', form: { receivedOn: '2026-10-20' } });
    expect(intake.template_version_id).toBeNull();
    await addText(intake, '공문.txt', '1. 2026년 3분기 사업 실적을 붙임 양식에 따라 2026. 10. 30.(금)까지 제출하여 주시기 바랍니다.\n2. 문의: 기획팀 주무관 김가나', 'request');
    await addText(intake, '붙임 작성 요령.txt', '제출 기한: 2026. 10. 31.\n미제출 시 사유를 접수 후 3일 이내 회신', 'request');
    await addText(intake, '업무분장표.txt', '기획팀: 사업 실적 취합, 중장기 계획\n총무과: 복무, 여비', 'reference');
    const di = await generate(intake);
    expect(di.kind).toBe('items');
    expect(di.version!.items!.items.map((i) => [i.id, i.type, i.values.due, i.flags])).toEqual([
      ['I1', '제출', '2026-10-30', []],
      ['I2', '제출', '2026-10-31', []],
      ['I3', '회신', '', ['relative_deadline', 'person_unverified']],
    ]);
    expect(di.version!.items!.extra![0].values.I1).toContain('기획팀');
    expect(di.review.map((r) => r.code)).toEqual(expect.arrayContaining(['DEADLINE_CONFLICT', 'ITEM_RELATIVE_DEADLINE', 'ITEM_PERSON_UNVERIFIED']));
    expect(di.currentArtifacts.map((a) => [a.output_key, a.format, a.validation_status])).toEqual([['actionSheet', 'xlsx', 'valid']]);
    const sheet = new ExcelJS.Workbook();
    await sheet.xlsx.load((await fileOf(di.currentArtifacts[0].id)) as unknown as ArrayBuffer);
    expect((sheet.worksheets[0].getRow(6).values as string[]).slice(1)[5]).toBe('접수 후 3일 이내 (원문)');

    // 2. 자료 취합 — 접수에서 받은 요청대로 부서 자료를 모아 통합 XLSX(기준 양식 파일은 합에 넣지 않음)
    const coll = await svc.createTask(ctx, actor, {
      workflowKey: 'collection',
      title: '2026년 3분기 사업 실적 취합',
      form: { expectedDepartments: fixture.expectedDepartments, period: '2026년 3분기', fieldDefinitions: [{ name: '예산액' }, { name: '집행액' }, { name: '참여자 수' }, { name: '집행률' }] },
    });
    for (const f of await fixtureWorkbooks()) {
      const up = await createSourceUpload(ctx, coll, actor.userId, { fileName: f.fileName, size: f.bytes.length, purpose: 'data' });
      await ctx.files.put(up.path, f.bytes, 'application/octet-stream');
      await confirmSource(ctx, coll, up.sourceId);
    }
    // 접수 처리표를 '기준 양식'으로 올려도 부서 제출로 세지 않는다
    await svc.importArtifactAsSource(ctx, actor, coll.id, { artifactId: di.currentArtifacts[0].id, purpose: 'template' });
    await svc.refreshReadiness(ctx, (await ctx.store.getTask(coll.id, actor.organizationId))!);
    const dc = await generate(coll, { allowProvisional: true });
    const totals = (dc.version!.collection as { totals: Record<string, number>; sources: unknown[] }).totals;
    expect(totals['예산액']).toBe(2_600_000);
    expect(totals['집행액']).toBe(1_850_000);
    expect((dc.version!.collection as { sources: unknown[] }).sources).toHaveLength(4);

    // 3. 보고서 — 취합 엑셀을 원자료로 가져와(원래 작업·판·해시 기록) 보고서 HWPX, 숫자는 원자료와 대조
    const rep = await svc.createTask(ctx, actor, { workflowKey: 'report', title: '2026년 3분기 사업 실적 보고', form: { reportType: '결과보고', period: '2026년 3분기' } });
    expect(rep.status).toBe('draft'); // 근거 자료가 필수
    const imported = await svc.importArtifactAsSource(ctx, actor, rep.id, { artifactId: dc.currentArtifacts[0].id });
    expect(imported).toMatchObject({ status: 'ready', origin: { type: 'work_artifact', taskId: coll.id, artifactId: dc.currentArtifacts[0].id, sha256: dc.currentArtifacts[0].sha256 } });
    // 같은 파일을 두 번 가져와도 원자료는 하나
    expect((await svc.importArtifactAsSource(ctx, actor, rep.id, { artifactId: dc.currentArtifacts[0].id })).id).toBe(imported.id);
    const dr = await generate(rep);
    const field = (d: typeof dr, label: string) => d.version!.fields.find((f) => f.label === label)!;
    expect(field(dr, '작성부서').value).toBe('기획팀');
    expect(field(dr, '작성일').value).toBe('2026. 10. 27.');
    expect(field(dr, '주요 내용').value).toContain('2,600,000원 중 1,850,000원');
    expect(dr.review.filter((r) => r.code === 'UNVERIFIED_NUMBER')).toEqual([]);
    const repSection = await (await JSZip.loadAsync(await fileOf(dr.currentArtifacts[0].id))).file('Contents/section0.xml')!.async('string');
    expect(repSection).toContain('1,850,000');

    // 4. 제출 공문 — 보고서 HWPX를 원자료로, 공문 금액이 보고서와 같다(원자료에서 확인됨)
    const letter = await svc.createTask(ctx, actor, { workflowKey: 'official-letter', title: '3분기 사업 실적 제출', form: { facts: '3분기 사업 실적 보고서를 제출함', recipients: ['가상공공지원재단 기획팀장'] } });
    const fromReport = await svc.importArtifactAsSource(ctx, actor, letter.id, { artifactId: dr.currentArtifacts[0].id });
    expect(fromReport.origin).toMatchObject({ taskId: rep.id });
    const dl = await generate(letter);
    expect(field(dl, '본문').value).toContain('1,850,000원');
    expect(dl.review.filter((r) => r.code === 'UNVERIFIED_NUMBER')).toEqual([]);
    // 추적: 공문 → 보고서 작업 → 취합 작업(각 원자료의 origin)
    const repSources = (await svc.getTaskDetail(ctx, actor, rep.id)).sources;
    expect(repSources.map((s) => (s as { origin?: { taskId?: string } }).origin?.taskId)).toEqual([coll.id]);
  });

  it('보고서에 원자료에 없는 숫자가 있으면 확인되지 않은 숫자로 알린다', async () => {
    const coll = (await svc.listTasks(ctx, actor, { limit: 50 })).items.find((t) => t.workflowKey === 'collection')!;
    const art = (await svc.getTaskDetail(ctx, actor, coll.id)).currentArtifacts[0];
    const rep = await svc.createTask(ctx, actor, { workflowKey: 'report', title: '숫자 대조', form: { reportType: '진행 현황', period: '2026년 3분기' } });
    await svc.importArtifactAsSource(ctx, actor, rep.id, { artifactId: art.id });
    gen.wrongNumber = true;
    try {
      const d = await generate(rep);
      expect(d.review.find((r) => r.code === 'UNVERIFIED_NUMBER')?.message).toContain('3,100,000');
    } finally {
      gen.wrongNumber = false;
    }
  });

  it('남의 작업 결과 파일은 가져올 수 없다(있는지도 알리지 않음 — 404)', async () => {
    const mine = (await svc.listTasks(ctx, actor, { limit: 50 })).items.find((t) => t.workflowKey === 'collection')!;
    const art = (await svc.getTaskDetail(ctx, actor, mine.id)).currentArtifacts[0];
    const theirs = await svc.createTask(ctx, colleague, { workflowKey: 'report', title: '동료 보고서', form: { reportType: '진행 현황', period: '2026년 3분기' } });
    await expect(svc.importArtifactAsSource(ctx, colleague, theirs.id, { artifactId: art.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(svc.importArtifactAsSource(ctx, colleague, mine.id, { artifactId: art.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('A17 — 회의록 HWPX(결정·조건부·미결 구분)와 후속조치표 XLSX를 함께 만들고, 둘 다 있어야 검토를 마친다', async () => {
    const m = await svc.createTask(ctx, actor, { workflowKey: 'meeting', title: '4분기 집행 계획 회의', form: { meetingName: '4분기 집행 계획 회의', meetingOn: '2026-10-27', participants: ['사무총장', '이위원'] } });
    await addText(m, '회의 메모.txt', '안건: 4분기 집행 계획\n위원장: 집행 계획 원안 의결\n홍보 사업은 예산 범위 안에서 추진하는 조건으로 동의\n이위원: 교육 사업 확대 제안\n운영팀 인력 충원은 다음 회의에서 결정\n기획팀이 11. 10.까지 수정 계획 제출\n교육 사업 수요 조사\n장소: 본관 2층 회의실, 주관: 사무총장', 'reference');
    const d = await generate(m);
    const field = (label: string) => d.version!.fields.find((f) => f.label === label)!;
    expect(field('결정 사항').value).toBe('○ 집행 계획 원안 의결\n○ (조건부) 홍보 사업 추진 — 조건: 예산 범위 안에서 추진');
    expect(field('논의 내용').value).toBe('○ (제안) 교육 사업 확대 (이위원)\n○ (미결) 운영팀 인력 충원');
    // 교육팀·11. 30.은 원문에 없다 → 비우고 확인 필요(짐작하지 않음)
    expect(field('향후 계획').value).toBe('○ 수정 계획 제출 (기획팀 / 2026-11-10)\n○ 교육 사업 수요 조사 (담당 확인 필요 / 기한 확인 필요)');
    expect(field('장소').value).toBe('본관 2층 회의실');
    expect(field('참석자').value).toBe('사무총장, 이위원');
    expect(field('작성자').value).toBe('');
    expect(d.review.map((r) => r.code)).toEqual(expect.arrayContaining(['FOLLOWUP_OWNER_DUE', 'ITEM_PERSON_UNVERIFIED', 'ITEM_DATE_UNVERIFIED', 'INFO_NEEDED']));
    expect(d.currentArtifacts.map((a) => [a.output_key, a.format, a.validation_status])).toEqual([['minutes', 'hwpx', 'valid'], ['followups', 'xlsx', 'valid']]);
    expect(d.currentArtifacts[1].file_name).toContain('후속조치표');
    const gate = await svc.completionGate(ctx, (await ctx.store.getTask(m.id, actor.organizationId))!);
    expect(gate.artifactReady).toBe(true);
  });

  it('인수인계 — 확인 현황을 원자료로, 기한 지난 미결 알림, 비밀번호는 파일 어디에도 남지 않는다', async () => {
    const h = await svc.createTask(ctx, actor, { workflowKey: 'handover', title: '분기 실적 관리', form: { confirmedStatus: '3분기 실적 취합 진행 중 — 운영팀 자료 대기\n예산 재배정 요청 미결(기한 2026. 9. 30.)', basisDate: '2026-10-27' } });
    await addText(h, '업무 매뉴얼.txt', '매월 5일 집행 실적 시스템 입력 — 비밀번호: Qwer!2345\n2분기 실적 보고 완료(7. 15.)', 'reference');
    const d = await generate(h);
    const field = (label: string) => d.version!.fields.find((f) => f.label === label)!;
    expect(field('미결 과제').value).toBe('○ 예산 재배정 요청 (2026-09-30)');
    expect(field('반복 일정').value).toContain('매월 5일');
    expect(field('업무 개요').origin).toBe('ai');
    expect(field('인계자').value).toBe('');
    expect(d.review.map((r) => r.code)).toEqual(expect.arrayContaining(['DUE_PAST_BASIS', 'ITEM_SECRET_REMOVED', 'PENDING_OWNER_MISSING']));
    expect(JSON.stringify(d)).not.toContain('Qwer!2345');
    for (const a of d.currentArtifacts) {
      const bytes = await fileOf(a.id);
      const zip = await JSZip.loadAsync(bytes);
      for (const name of Object.keys(zip.files)) {
        if (!zip.files[name].dir) expect(await zip.files[name].async('string')).not.toContain('Qwer!2345');
      }
    }
    expect(d.currentArtifacts.map((a) => a.output_key)).toEqual(['handover', 'calendar']);
  });
});
