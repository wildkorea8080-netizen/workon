import { readFileSync } from 'fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import ExcelJS from 'exceljs';
import {
  BATCH_EXPECT_MAX, expectMissing, expectVerdict, normalizeExpect, parseBatchTable, splitExpectKeywords,
} from '@/lib/apps/batch-spec';
import { batchWorkbook, runDueBatchItems, type BatchDeps, type BatchItemRun, type ItemPatch, type WebhookResultPatch } from '@/lib/apps/batches';
import type { RunAsOutcome } from '@/lib/apps/run-as';
import { previewBatch, previewFileBatch } from '@/components/apps/AppBatchPanel';
import { keywordKey, missingKeywords } from '@/lib/rag-eval-answer';
import type { AppDefinition } from '@/lib/apps/definition';

/** 일괄 실행의 기대 핵심어(0088)·비동기 연동 묶음의 마지막 결과(0087 뒤) */

const fields = [{ key: 'topic', label: '주제' }];
const definition: AppDefinition = { schemaVersion: 1, output: 'bullets', fields: [{ key: 'topic', label: '주제', type: 'text', required: true }] };

describe('기대 핵심어 규칙', () => {
  it('나누기 — 쉼표·세미콜론·가운뎃점·줄바꿈, 다듬고 같은 것·빈 것 빼고 20개', () => {
    expect(splitExpectKeywords(' 일비 2만원, KTX ;특실·  일비 \n\n')).toEqual(['일비 2만원', 'KTX', '특실', '일비']);
    expect(splitExpectKeywords('a,a, ,b')).toEqual(['a', 'b']);
    expect(splitExpectKeywords(Array.from({ length: 30 }, (_, i) => `k${i}`).join(','))).toHaveLength(20);
    expect(splitExpectKeywords(null)).toEqual([]);
  });
  it('다듬기 — 비면 null, 너무 길면 too_long', () => {
    expect(normalizeExpect('  여비 ,  일비 ')).toBe('여비, 일비');
    expect(normalizeExpect(' , ')).toBeNull();
    expect(normalizeExpect(3)).toBeNull();
    expect(normalizeExpect(Array.from({ length: 20 }, (_, i) => `${i}${'x'.repeat(40)}`).join(','))).toBe('too_long');
    expect(BATCH_EXPECT_MAX).toBe(500);
  });
  it('재기 — 문서 찾기 평가의 핵심어와 같은 규칙(공백·대소문자·숫자 쉼표 무시)', () => {
    expect(expectMissing('일비는 20,000 원이고 KTX 일반실', '20000원, ktx, 특실')).toEqual(['특실']);
    expect(expectMissing('아무 말', '')).toEqual([]);
    expect(keywordKey('1,200 원')).toBe('1200원');
    expect(missingKeywords('ab', ['A', 'c'])).toEqual(['c']);
  });
  it('판정 글', () => {
    expect(expectVerdict(null, null)).toBe('');
    expect(expectVerdict('a', null)).toBe('재지 않음');
    expect(expectVerdict('a', [])).toBe('맞음');
    expect(expectVerdict('a, b', ['b'])).toBe('빠짐: b');
  });
});

describe('표의 기대 핵심어 칸', () => {
  it('머리글 이름 넷 중 하나 — 입력 항목이 아니라 줄마다 핵심어', () => {
    expect(parseBatchTable('주제\t기대 핵심어\n여비\t일비, KTX\n복무\t', fields)).toEqual({ ok: true, rows: [{ topic: '여비' }, { topic: '복무' }], expects: ['일비, KTX', ''] });
    expect(parseBatchTable('Expect,주제\n"a, b",여비', fields)).toEqual({ ok: true, rows: [{ topic: '여비' }], expects: ['a, b'] });
  });
  it('입력 항목 이름이 같으면 입력 항목이 먼저 · 두 번이면 오류 · 너무 길면 그 줄 오류', () => {
    expect(parseBatchTable('핵심어\n여비', [{ key: 'kw', label: '핵심어' }])).toEqual({ ok: true, rows: [{ kw: '여비' }], expects: [''] });
    expect(parseBatchTable('주제\t기대 답\t기대 핵심어\n여비\ta\tb', fields)).toMatchObject({ ok: false, errors: ['기대 핵심어 칸이 머리글에 두 번 있습니다.'] });
    const long = Array.from({ length: 20 }, (_, i) => `${i}${'x'.repeat(40)}`).join(',');
    expect(parseBatchTable(`주제\t기대 핵심어\n여비\t${long}`, fields)).toMatchObject({ ok: false, errors: ['2번째 줄: 기대 핵심어는 500자까지입니다.'] });
  });
  it('미리 보기도 핵심어를 넘긴다(표·파일마다 한 건)', () => {
    expect(previewBatch(definition, '주제\t기대 핵심어\n여비\t일비')).toMatchObject({ ok: true, expects: ['일비'] });
    const fileDef: AppDefinition = { ...definition, fields: [{ key: 'topic', label: '주제', type: 'text', required: false }], attachments: { required: true } } as AppDefinition;
    expect(previewFileBatch(fileDef, '', 2)).toMatchObject({ ok: true, expects: [''] });
    expect(previewFileBatch(fileDef, '주제\t기대 핵심어\n가\t나', 2)).toMatchObject({ ok: true, expects: ['나'] });
  });
});

describe('실행기 — 핵심어 재기·연동 마지막 결과', () => {
  const batch = { id: 'b1', organization_id: 'o1', department_id: 'd1', user_id: 'u1', agent_id: 'a1', app_version: 2, status: 'running' as const };
  const item = (position: number, over: Partial<BatchItemRun> = {}): BatchItemRun => ({ id: `i${position}`, batch_id: 'b1', position, inputs: { topic: `q${position}` }, status: 'pending', attempts: 0, claimed_at: null, batch, ...over });
  function deps(outcomes: RunAsOutcome[], items: BatchItemRun[], over: Partial<BatchDeps> = {}) {
    const finished: Array<{ id: string; patch: ItemPatch }> = [];
    const results: Array<{ id: string; patch: WebhookResultPatch }> = [];
    let i = 0;
    const d: BatchDeps = {
      now: () => 0, openItems: async () => items, claim: async () => true,
      run: vi.fn(async () => outcomes[i++] ?? ({ kind: 'completed', conversationId: 'c', messageId: 'm' } as RunAsOutcome)),
      finishItem: async (id, patch) => { finished.push({ id, patch }); },
      stop: async () => true, settle: async () => false, log: async () => {},
      resultText: vi.fn(async (id: string) => (id === 'm1' ? '일비는 2만원이고 KTX를 탄다' : id === 'gone' ? null : '아무것도')),
      webhookResult: vi.fn(async (id: string, patch: WebhookResultPatch) => { results.push({ id, patch }); }),
      ...over,
    };
    return { d, finished, results };
  }

  it('핵심어가 있는 줄만 답변 글로 재 expect_missing에 둔다(없거나 못 읽으면 칸 없음)', async () => {
    const t = deps([
      { kind: 'completed', conversationId: 'c1', messageId: 'm1' },
      { kind: 'completed', conversationId: 'c2', messageId: 'm2' },
      { kind: 'completed', conversationId: 'c3', messageId: 'm3' },
      { kind: 'completed', conversationId: 'c4', messageId: 'gone' },
    ], [item(1, { expect: '일비, ktx' }), item(2, { expect: '일비, 특실' }), item(3), item(4, { expect: '일비' })], { now: () => 0 });
    await runDueBatchItems(t.d);
    const by = new Map(t.finished.map((f) => [f.id, f.patch]));
    expect(by.get('i1')?.expect_missing).toEqual([]);
    expect(by.get('i2')?.expect_missing).toEqual(['일비', '특실']);
    expect(by.get('i3')).not.toHaveProperty('expect_missing');
    expect(by.get('i4')).not.toHaveProperty('expect_missing');
    expect(t.d.resultText).toHaveBeenCalledTimes(3);
  });
  it('답변 글 읽기가 던져도 줄은 마친다(재지 않음)', async () => {
    const t = deps([{ kind: 'completed', conversationId: 'c1', messageId: 'm1' }], [item(1, { expect: 'a' })], { resultText: async () => { throw new Error('db'); } });
    await runDueBatchItems(t.d);
    expect(t.finished[0].patch).toMatchObject({ status: 'done' });
    expect(t.finished[0].patch).not.toHaveProperty('expect_missing');
  });
  it('비동기 연동 묶음 — 마침·실패·멈춤이 그 연동의 마지막 결과를 바꾸고, 다시 해 볼 실패는 안 바꾼다', async () => {
    const wb = { ...batch, webhook_id: 'w1' };
    const done = deps([{ kind: 'completed', conversationId: 'c1', messageId: 'm1' }], [item(1, { batch: wb })]);
    await runDueBatchItems(done.d);
    expect(done.results).toEqual([{ id: 'w1', patch: { last_status: 'completed', last_error: null, last_conversation_id: 'c1' } }]);

    const retry = deps([{ kind: 'failed', error: '모델 오류', conversationId: 'c2' }], [item(1, { batch: wb })]);
    await runDueBatchItems(retry.d);
    expect(retry.results).toEqual([]);

    const failed = deps([{ kind: 'failed', error: '모델 오류', conversationId: 'c2' }], [item(1, { batch: wb, attempts: 1 })]);
    await runDueBatchItems(failed.d);
    expect(failed.results).toEqual([{ id: 'w1', patch: { last_status: 'failed', last_error: '모델 오류', last_conversation_id: 'c2' } }]);

    const stopped = deps([{ kind: 'rejected', status: 409, message: 'x' }], [item(1, { batch: wb })]);
    await runDueBatchItems(stopped.d);
    expect(stopped.results).toEqual([{ id: 'w1', patch: { last_status: 'failed', last_error: '앱 설정이 바뀌어 멈췄습니다 — 지금 앱으로 새로 만들어 주세요.', last_conversation_id: null } }]);
  });
  it('손으로 만든 묶음은 연동을 건드리지 않고, 연동 바꾸기가 던져도 실행기는 이어 간다', async () => {
    const manual = deps([], [item(1)]);
    await runDueBatchItems(manual.d);
    expect(manual.d.webhookResult).not.toHaveBeenCalled();
    const flaky = deps([], [item(1, { batch: { ...batch, webhook_id: 'w1' } }), item(2, { batch: { ...batch, webhook_id: 'w1' } })], { webhookResult: async () => { throw new Error('db'); } });
    expect(await runDueBatchItems(flaky.d)).toMatchObject({ done: 2 });
  });
});

describe('목록·엑셀·연결', () => {
  it('엑셀 — 핵심어가 있는 묶음만 두 열(기대 핵심어·판정), 마치지 않은 줄은 재지 않음', async () => {
    const base = { conversationId: null, inputs: { topic: '여비' }, error: null, result: '결과' };
    const buf = await batchWorkbook({ name: '시험', origin: 'https://x', fields: [{ key: 'topic', label: '주제' }], items: [
      { ...base, position: 1, status: 'done', expect: '일비, KTX', expectMissing: ['KTX'] },
      { ...base, position: 2, status: 'done', expect: '일비', expectMissing: [] },
      { ...base, position: 3, status: 'failed', expect: '일비', expectMissing: null },
      { ...base, position: 4, status: 'done', expect: null, expectMissing: null },
    ] });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const rows = wb.getWorksheet('결과')!.getSheetValues().slice(1) as unknown[][];
    expect(rows[0].slice(-2)).toEqual(['기대 핵심어', '핵심어 판정']);
    expect(rows[1].slice(-2)).toEqual(['일비, KTX', '빠짐: KTX']);
    expect(rows[2].slice(-2)).toEqual(['일비', '맞음']);
    expect(rows[3].slice(-2)).toEqual(['일비', '재지 않음']);
    const noExpect = await batchWorkbook({ name: '시험', origin: 'https://x', fields: [{ key: 'topic', label: '주제' }], items: [{ ...base, position: 1, status: 'done' }] });
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(noExpect);
    expect(JSON.stringify(wb2.getWorksheet('결과')!.getRow(1).values)).not.toContain('핵심어');
  });
  it('연결(원본) — 만들기·다시 실행이 핵심어를 싣고, 목록이 맞은 줄을 세고, 실행기가 칸을 읽고, 화면이 보낸다', () => {
    const lib = readFileSync('src/lib/apps/batches.ts', 'utf8');
    expect(lib).toContain("...(rowExpects[i] ? { expect: rowExpects[i] } : {})");
    expect(lib).toContain("expects: tableRows.map((r) => r.expect ?? '')");
    expect(lib).toContain("select('batch_id, status, expect_missing')");
    expect(lib).toContain("select('id, batch_id, position, inputs, status, attempts, claimed_at, file, expect')");
    expect(lib).toContain("select('id, organization_id, department_id, user_id, agent_id, app_version, status, webhook_id')");
    expect(lib).toContain("'기대 핵심어는 줄마다 하나씩(줄 수와 같게) 보내 주세요.'");
    const panel = readFileSync('src/components/apps/AppBatchPanel.tsx', 'utf8');
    expect(panel).toContain('...(preview.expects.some(Boolean) ? { expects: preview.expects } : {})');
    expect(panel).toContain('핵심어 맞음 ${b.expectPassed ?? 0}/${b.expectChecked}');
    expect(readFileSync('src/lib/rag-eval-answer.ts', 'utf8')).toContain("export { keywordKey, missingKeywords } from '@/lib/keyword-match';");
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!url)('기대 핵심어 칸 (0088, 시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
    const sql = readFileSync('supabase/migrations/0088_app_batch_expect.sql', 'utf8');
    await db.query(sql);
    await db.query(sql);
  });
  afterAll(async () => { await db?.end(); });
  it('칸 둘·CHECK 둘 — 빈 글·500자 넘음·핵심어 없이 판정·21개 판정은 거절', async () => {
    const cols = await db.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='app_batch_items' AND column_name IN ('expect','expect_missing') ORDER BY 1");
    expect(cols.rows).toEqual([{ column_name: 'expect', data_type: 'text' }, { column_name: 'expect_missing', data_type: 'ARRAY' }]);
    const con = await db.query("SELECT conname FROM pg_constraint WHERE conname IN ('app_batch_items_expect_check','app_batch_items_expect_missing_check') ORDER BY 1");
    expect(con.rows.map((r) => r.conname)).toEqual(['app_batch_items_expect_check', 'app_batch_items_expect_missing_check']);
    // 실제 행으로 CHECK — 트랜잭션 안에서 만들고 되돌린다
    await db.query('BEGIN');
    try {
      const org = await db.query("INSERT INTO organizations (name) VALUES ('시험 기관 0088') RETURNING id");
      const dept = await db.query("INSERT INTO departments (name, slug, organization_id) VALUES ('시험 부서', 'test-0088', $1) RETURNING id", [org.rows[0].id]);
      const user = await db.query("INSERT INTO users (email, department_id) VALUES ('t0088@test.invalid', $1) RETURNING id", [dept.rows[0].id]);
      const agent = await db.query("INSERT INTO agents (name, department_id, organization_id, tier, visibility) VALUES ('시험 앱', $1, $2, 'official', 'organization') RETURNING id", [dept.rows[0].id, org.rows[0].id]);
      const b = await db.query("INSERT INTO app_batches (organization_id, department_id, user_id, agent_id, app_version, name, total) VALUES ($1,$2,$3,$4,1,'시험',1) RETURNING id",
        [org.rows[0].id, dept.rows[0].id, user.rows[0].id, agent.rows[0].id]);
      const ins = (expect: string | null, missing: string[] | null) => db.query("INSERT INTO app_batch_items (batch_id, position, inputs, expect, expect_missing) VALUES ($1, 1, '{}', $2, $3)", [b.rows[0].id, expect, missing]);
      const fails = async (p: () => Promise<unknown>) => { await db.query('SAVEPOINT s'); try { await p(); return false; } catch { return true; } finally { await db.query('ROLLBACK TO SAVEPOINT s'); } };
      expect(await fails(() => ins('', null))).toBe(true);
      expect(await fails(() => ins('x'.repeat(501), null))).toBe(true);
      expect(await fails(() => ins(null, []))).toBe(true);
      expect(await fails(() => ins('a', Array.from({ length: 21 }, (_, i) => `k${i}`)))).toBe(true);
      expect(await fails(() => ins('a, b', ['b']))).toBe(false);
    } finally { await db.query('ROLLBACK'); }
  });
});
