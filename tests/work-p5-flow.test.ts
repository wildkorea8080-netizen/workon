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
import { mockGenerator } from '@/lib/work/generation/compose';
import { confirmSource, createSourceUpload } from '@/lib/work/sources';
import type { WorkContext } from '@/lib/work/context';
import type { QaModel, QaInput } from '@/lib/work/workflows/qa/model';
import type { RawQa } from '@/lib/work/workflows/qa/verify';
import type { WorkActor, WorkTaskRow } from '@/lib/work/types';
import * as svc from '@/lib/work/services';
import { runWorker } from '@/lib/work/runs/worker';
import { hotelReceipt, settlementWorkbooks } from './helpers/settlement-fixture';

/**
 * P5 흐름 — 실제 서비스·실행기·Postgres(0034)·한글로 만든 양식. 질문별 답변 모델만 가짜(대사는 모델을 안 부름).
 * 완료 기준(07 문서 P5): 각 업무가 기본 산출 파일을 만들고 필수 입력·검토 규칙을 만족. A18·A19.
 */
const url = process.env.WORK_TEST_DATABASE_URL;
const key = () => `k-${randomUUID()}`;

class FakeQa implements QaModel {
  async answer(input: QaInput) {
    let raw: RawQa;
    if (input.kind === 'reply') {
      raw = {
        questions: [
          { text: '주차장 이용 시간 연장', quote: '주차장 이용 시간을 늘릴 수 있나요?', sourceId: 'inquiry' },
          { text: '야간 조명 수리 시기', quote: '야간 조명 고장은 언제 고쳐지나요?', sourceId: 'inquiry' },
        ],
        answers: [{ question: 1, text: '현재 07시~22시 운영하며 연장 계획은 확정되지 않았습니다.', evidence: ['F1'], status: 'answered' }],
        priorDiffs: [],
      };
    } else {
      const req = input.questionSources[0].id;
      raw = {
        questions: [
          { text: '민원 평균 처리 기간', quote: '2026년 1~9월 민원 평균 처리 기간', sourceId: req },
          { text: '민원 만족도', quote: '민원 만족도 조사 결과', sourceId: req },
        ],
        answers: [
          { question: 1, text: '2026년 1~9월 평균 4.2일입니다.', evidence: [input.evidenceSources[0].id], status: 'answered' },
          { question: 2, text: '만족도 조사 자료가 없어 확인이 필요합니다.', evidence: [], status: 'needs_info' },
        ],
        priorDiffs: [{ question: 1, label: '평균 처리 기간', current: '4.2일', prior: '4.8일', reason: '산정 기준을 접수일 기준으로 바꿈' }],
      };
    }
    return { raw, usage: { model: 'claude-sonnet-4-6', input_tokens: 500, output_tokens: 200 }, mode: 'llm' as const };
  }
}

describe.skipIf(!url)('P5 업무(실제 Postgres·실제 파일)', () => {
  let pool: pg.Pool;
  let ctx: WorkContext;
  let actor: WorkActor;

  async function upload(task: WorkTaskRow, name: string, bytes: Buffer, purpose: string) {
    const up = await createSourceUpload(ctx, task, actor.userId, { fileName: name, size: bytes.length, purpose });
    await ctx.files.put(up.path, bytes, 'application/octet-stream');
    expect((await confirmSource(ctx, task, up.sourceId)).status).toBe('ready');
    await svc.refreshReadiness(ctx, (await ctx.store.getTask(task.id, actor.organizationId))!);
    return (await ctx.store.getTask(task.id, actor.organizationId))!;
  }

  async function generate(task: WorkTaskRow) {
    const r = await svc.requestGenerate(ctx, actor, task.id, { baseVersion: 0, idempotencyKey: key() });
    expect((await runWorker(ctx, { workerId: 'w', runId: r.run.id }))[0]).toMatchObject({ finish: 'succeeded' });
    return svc.getTaskDetail(ctx, actor, task.id);
  }

  const fileOf = async (id: string) => (await ctx.files.get((await ctx.store.getArtifact(id, actor.organizationId))!.storage_path))!;

  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    pool = new pg.Pool({ connectionString: url, max: 4 });
    ctx = {
      store: createPgWorkStore(pool),
      files: createLocalWorkFiles(mkdtempSync(path.join(tmpdir(), 'workon-p5-'))),
      generator: mockGenerator,
      generatorMode: 'llm',
      renderer: unavailableRenderer,
      qa: { model: new FakeQa() },
      resolveModel: async () => 'claude-sonnet-4-6',
      checkLimit: async () => ({ allowed: true }),
      log: async (p) => { if (p.level === 'error') console.error('[work-log]', JSON.stringify(p.details)); },
      now: () => new Date('2026-10-27T01:00:00Z'),
    };
    const orgId = randomUUID(), deptId = randomUUID(), userId = randomUUID();
    await pool.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, '가상공공지원재단']);
    await pool.query('INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, $2, $3, $4)', [deptId, '시설관리과', `d-${deptId.slice(0, 8)}`, orgId]);
    await pool.query('INSERT INTO users (id, email, department_id) VALUES ($1, $2, $3)', [userId, `${userId}@test.local`, deptId]);
    await pool.query('INSERT INTO work_org_settings (organization_id, home_enabled, new_tasks_enabled) VALUES ($1, true, true)', [orgId]);
    actor = { userId, organizationId: orgId, departmentId: deptId, isAdmin: false, managedDepartmentIds: [] };
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('A18 — 예산·집행·증빙·기준 세 갈래가 다 있어야 만들 준비가 되고, 대사표 XLSX에 취소 짝·중복·초과가 남으며 지급은 없다', async () => {
    let task = await svc.createTask(ctx, actor, { workflowKey: 'settlement', title: '2026년 9월 사업비 정산', form: { period: '2026년 9월' } });
    expect(task.template_version_id).toBeNull();
    const { budgetLedger, evidenceList } = await settlementWorkbooks();
    task = await upload(task, '예산·집행.xlsx', budgetLedger, 'data');
    expect(task.status).toBe('draft'); // 증빙·기준이 아직
    task = await upload(task, '카드 매출전표.xlsx', evidenceList, 'evidence');
    task = await upload(task, '호텔 영수증.txt', Buffer.from(hotelReceipt, 'utf8'), 'evidence');
    expect(task.status).toBe('draft'); // 적용 기준이 아직
    task = await upload(task, '여비 지급 기준.txt', Buffer.from('숙박비는 1박 상한액 범위에서 실비 지급', 'utf8'), 'reference');
    expect(task.status).toBe('ready');
    const d = await generate(task);
    expect(d.kind).toBe('settlement');
    const s = d.version!.settlement!;
    expect(s.totals.executed).toBe(905_000);
    expect(s.budget.find((b) => b.item === '회의비')!.balance).toBe(-75_000);
    expect(d.review.find((r) => r.code === 'OVER_BUDGET')!.severity).toBe('blocking');
    await expect(svc.reviewTask(ctx, actor, task.id, { action: 'approve', versionId: d.version!.id })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(d.currentArtifacts.map((a) => [a.output_key, a.format, a.validation_status])).toEqual([['reconciliation', 'xlsx', 'valid']]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await fileOf(d.currentArtifacts[0].id)) as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet('대사표')!;
    const flags = Array.from({ length: 9 }, (_, i) => String(sheet.getRow(4 + i).getCell(9).value ?? ''));
    expect(flags[2]).toBe('취소 짝');
    expect(flags[1]).toContain('중복 의심');
    // 모델을 부르지 않는다 — 사용 기록 없음
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM usage_logs WHERE details->>'task_id' = $1", [task.id]);
    expect(rows[0].n).toBe(0);
  });

  it('A19 — 회신: 답이 빠진 질문이 있으면 검토를 마칠 수 없고, 칸은 질문별로, 담당 부서는 프로그램이·연락처는 직원이', async () => {
    const task = await svc.createTask(ctx, actor, {
      workflowKey: 'reply',
      title: '주차장 이용 문의 회신',
      form: { inquiry: '주차장 이용 시간을 늘릴 수 있나요? 그리고 지난주 신고한 야간 조명 고장은 언제 고쳐지나요?', confirmedFacts: '주차장 운영 시간은 07시~22시이며 연장 계획은 확정되지 않음', recipient: '민원인' },
    });
    expect(task.status).toBe('ready'); // 파일 입력은 선택
    const d = await generate(task);
    const field = (label: string) => d.version!.fields.find((f) => f.label === label)!;
    expect(field('답변').value).toBe('1. 주차장 이용 시간 연장\n→ 현재 07시~22시 운영하며 연장 계획은 확정되지 않았습니다.\n2. 야간 조명 수리 시기\n→ (답변 없음 — 확인 필요)');
    expect(field('답변').origin).toBe('ai');
    expect(field('담당 부서').value).toBe('시설관리과');
    expect(field('연락처').value).toBe('');
    expect(field('수신').value).toBe('민원인');
    expect(d.version!.qa!.pairs.map((p) => p.flags)).toEqual([[], ['unanswered']]);
    expect(d.review.find((r) => r.code === 'QA_UNANSWERED')!.severity).toBe('blocking');
    expect(d.currentArtifacts[0]).toMatchObject({ output_key: 'reply', format: 'hwpx', validation_status: 'valid' });
    const section = await (await JSZip.loadAsync(await fileOf(d.currentArtifacts[0].id))).file('Contents/section0.xml')!.async('string');
    expect(section).toContain('주차장 이용 시간 연장');
    await expect(svc.reviewTask(ctx, actor, task.id, { action: 'approve', versionId: d.version!.id })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('A19 — 감사: 요구서·증빙 둘 다 있어야 준비, 요구 항목별 답변 HWPX + 증빙목록·수치 대조 XLSX, 사실 확인 필요 표시', async () => {
    let task = await svc.createTask(ctx, actor, {
      workflowKey: 'audit-response',
      title: '민원 처리 실적 요구자료',
      form: { indicatorDefinitions: [{ name: '민원 처리 기간(2026년 1~9월)' }] },
    });
    task = await upload(task, '요구서.txt', Buffer.from('1. 2026년 1~9월 민원 평균 처리 기간\n2. 민원 만족도 조사 결과', 'utf8'), 'request');
    expect(task.status).toBe('draft');
    task = await upload(task, '민원 처리 실적.txt', Buffer.from('평균 처리 기간 4.2일(2026년 1~9월)\n산정 기준을 접수일 기준으로 바꿈', 'utf8'), 'evidence');
    task = await upload(task, '2025 제출본.txt', Buffer.from('평균 처리 기간 4.8일', 'utf8'), 'reference');
    expect(task.status).toBe('ready');
    const d = await generate(task);
    expect(d.version!.qa!.pairs.map((p) => p.flags)).toEqual([[], ['needs_info', 'unsupported']]);
    expect(d.version!.qa!.pairs[0].priorDiffs).toEqual([{ label: '평균 처리 기간', current: '4.2일', prior: '4.8일', reason: '산정 기준을 접수일 기준으로 바꿈' }]);
    const field = (label: string) => d.version!.fields.find((f) => f.label === label)!;
    expect(field('제출 기관').value).toBe('가상공공지원재단');
    expect(field('기준 기간').value).toBe('민원 처리 기간(2026년 1~9월)');
    expect(field('확인 필요 사항').value).toContain('과거 4.8일 → 지금 4.2일 (산정 기준을 접수일 기준으로 바꿈)');
    expect(d.currentArtifacts.map((a) => [a.output_key, a.format, a.validation_status])).toEqual([['response', 'hwpx', 'valid'], ['evidenceIndex', 'xlsx', 'valid']]);
    expect(d.review.map((r) => r.code)).toEqual(expect.arrayContaining(['QA_NEEDS_INFO', 'QA_UNSUPPORTED']));
    expect(d.review.some((r) => r.code === 'UNVERIFIED_NUMBER')).toBe(false);
  });
});
