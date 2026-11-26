// tests/batch-0314.test.ts
// 앱 일괄 실행의 사람 판정(2026-11-26, 0126) — 만든 직원이 마친 줄마다 맞음·일부·틀림을 매기면 AI 채점과 맞대 일치율을 센다.
import { readFileSync } from 'fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import ExcelJS from 'exceljs';

type Call = { table: string; op: string; args: unknown[] };
const calls: Call[] = [];
let answers: Record<string, { data: unknown; error: unknown }> = {};

/** supabaseAdmin 흉내 — 표·동작(select·update)마다 정해 둔 답, 거친 사슬은 calls에 */
function chain(table: string) {
  let op = 'select';
  const b: Record<string, unknown> = {};
  const record = (name: string) => (...args: unknown[]) => { calls.push({ table, op: name, args }); if (name === 'update') op = 'update'; return b; };
  for (const name of ['select', 'update', 'eq', 'in', 'order', 'limit', 'range']) b[name] = record(name);
  const answer = () => answers[`${table}:${op}`] ?? { data: null, error: null };
  b.maybeSingle = () => Promise.resolve(answer());
  b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(answer()).then(ok, bad);
  return b;
}
vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: { from: (t: string) => chain(t) } }));

import {
  BATCH_HUMAN_BAD_INPUT, BATCH_HUMAN_ONLY_DONE, batchAgreement, batchAgreementSummary, parseHumanLabel,
} from '@/lib/apps/batch-spec';
import { batchWorkbook, labelBatchItem } from '@/lib/apps/batches';
import { itemInputPreview } from '@/components/apps/AppBatchItems';

const BATCH_ID = '11111111-1111-4111-8111-111111111111';
const batchRow = { id: BATCH_ID, agent_id: '22222222-2222-4222-8222-222222222222', name: '묶음', status: 'done', total: 3, stop_reason: null, created_at: '2026-11-26T00:00:00Z', finished_at: null, judge: true, user_id: 'u1' };
const itemRows = [
  { position: 1, status: 'done', error: null, conversation_id: 'c1', inputs: { topic: '여비' }, file: null, expect: '일비', expect_missing: [], judge_grade: 'correct', judge_reason: '맞음', human_grade: 'correct' },
  { position: 2, status: 'done', error: null, conversation_id: 'c2', inputs: { topic: '숙박' }, file: null, expect: '7만원', expect_missing: [], judge_grade: 'correct', judge_reason: '맞음', human_grade: 'incorrect' },
  { position: 3, status: 'failed', error: '실패', conversation_id: null, inputs: { topic: '교통' }, file: null, expect: '실비', expect_missing: null, judge_grade: null, judge_reason: null, human_grade: null },
];

describe('사람 판정 규칙', () => {
  it('요청 몸 — 줄 번호 정수 1~500·등급 셋 또는 null', () => {
    expect(parseHumanLabel({ position: 2, grade: 'partial' })).toEqual({ position: 2, grade: 'partial' });
    expect(parseHumanLabel({ position: 2, grade: null })).toEqual({ position: 2, grade: null });
    expect(parseHumanLabel({ position: 0, grade: 'correct' })).toBeNull();
    expect(parseHumanLabel({ position: 501, grade: 'correct' })).toBeNull();
    expect(parseHumanLabel({ position: 1.5, grade: 'correct' })).toBeNull();
    expect(parseHumanLabel({ position: '1', grade: 'correct' })).toBeNull();
    expect(parseHumanLabel({ position: 1, grade: 'great' })).toBeNull();
    expect(parseHumanLabel({ position: 1 })).toBeNull();
    expect(parseHumanLabel(null)).toBeNull();
    expect(BATCH_HUMAN_BAD_INPUT).toContain('position');
  });
  it('맞대기 — 문서 찾기 평가와 같은 셈(사람 판정이 없으면 없음, AI 채점 없는 줄은 맞대지 않음)', () => {
    expect(batchAgreement([{ judgeGrade: 'correct', humanGrade: null }])).toBeUndefined();
    const a = batchAgreement([
      { judgeGrade: 'correct', humanGrade: 'correct' },
      { judgeGrade: 'correct', humanGrade: 'incorrect' },
      { judgeGrade: 'incorrect', humanGrade: 'partial' },
      { judgeGrade: null, humanGrade: 'correct' },
    ])!;
    expect(a).toMatchObject({ labeled: 4, compared: 3, agree: 1, lenient: 1, strict: 1 });
    expect(a.matrix.incorrect.correct).toBe(1);
    expect(a.matrix.partial.incorrect).toBe(1);
    expect(batchAgreementSummary(a)).toBe(' · 사람 판정 4개 · AI 채점 일치 1/3(33%) · AI가 후하게 본 답 1 · AI가 짜게 본 답 1');
    expect(batchAgreementSummary(undefined)).toBe('');
  });
  it('줄 알아보기 — 파일 이름·입력값 셋까지·80자', () => {
    const fields = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }];
    expect(itemInputPreview({ inputs: { a: '여비\n규정', b: '' }, fileName: null }, fields)).toBe('여비 규정');
    expect(itemInputPreview({ inputs: { a: 'x', b: 'y' }, fileName: '보고.hwpx' }, fields)).toBe('보고.hwpx · x · y');
    expect(itemInputPreview({ inputs: { a: '가'.repeat(100) }, fileName: null }, fields)).toHaveLength(81);
  });
});

describe('labelBatchItem', () => {
  beforeEach(() => {
    calls.length = 0;
    answers = {
      'app_batches:select': { data: batchRow, error: null },
      'app_batch_items:update': { data: [{ position: 2 }], error: null },
      'app_batch_items:select': { data: itemRows, error: null },
      'agents:select': { data: { name: '여비 앱' }, error: null },
    };
  });
  it('만든 사람의 마친 줄만 바꾸고 맞대기와 함께 돌려줌', async () => {
    const out = await labelBatchItem('u1', BATCH_ID, 2, 'incorrect', Date.parse('2026-11-26T01:00:00Z'));
    expect(out.ok).toBe(true);
    const upd = calls.filter((c) => c.table === 'app_batch_items' && c.op === 'update')[0];
    expect(upd.args[0]).toEqual({ human_grade: 'incorrect', human_graded_at: '2026-11-26T01:00:00.000Z' });
    const eqs = calls.filter((c) => c.table === 'app_batch_items' && c.op === 'eq').map((c) => c.args);
    expect(eqs).toEqual(expect.arrayContaining([['batch_id', BATCH_ID], ['position', 2], ['status', 'done']]));
    const own = calls.filter((c) => c.table === 'app_batches' && c.op === 'eq').map((c) => c.args);
    expect(own).toEqual(expect.arrayContaining([['user_id', 'u1']]));
    if (!out.ok) return;
    expect(out.items.map((i) => i.humanGrade)).toEqual(['correct', 'incorrect', null]);
    expect(out.batch.agreement).toMatchObject({ labeled: 2, compared: 2, agree: 1, lenient: 1, strict: 0 });
  });
  it('지우기는 등급과 때를 함께 비움', async () => {
    await labelBatchItem('u1', BATCH_ID, 2, null);
    const upd = calls.find((c) => c.table === 'app_batch_items' && c.op === 'update')!;
    expect(upd.args[0]).toEqual({ human_grade: null, human_graded_at: null });
  });
  it('남의 묶음 404·못 읽음 503·마치지 않은 줄 409·저장 실패 503·다시 읽기 실패 503', async () => {
    answers['app_batches:select'] = { data: null, error: null };
    expect(await labelBatchItem('u2', BATCH_ID, 2, 'correct')).toMatchObject({ ok: false, status: 404 });
    answers['app_batches:select'] = { data: null, error: { code: 'x' } };
    expect(await labelBatchItem('u1', BATCH_ID, 2, 'correct')).toMatchObject({ ok: false, status: 503 });
    answers['app_batches:select'] = { data: batchRow, error: null };
    answers['app_batch_items:update'] = { data: [], error: null };
    expect(await labelBatchItem('u1', BATCH_ID, 3, 'correct')).toEqual({ ok: false, status: 409, message: BATCH_HUMAN_ONLY_DONE });
    answers['app_batch_items:update'] = { data: null, error: { code: 'x' } };
    expect(await labelBatchItem('u1', BATCH_ID, 2, 'correct')).toMatchObject({ ok: false, status: 503 });
    answers['app_batch_items:update'] = { data: [{ position: 2 }], error: null };
    answers['app_batch_items:select'] = { data: null, error: { code: 'x' } };
    expect(await labelBatchItem('u1', BATCH_ID, 2, 'correct')).toMatchObject({ ok: false, status: 503, message: expect.stringContaining('다시 읽지 못했습니다') });
  });
});

describe('엑셀·연결', () => {
  it('엑셀 — 사람 판정이 있을 때만 그 열', async () => {
    const base = { position: 1, status: 'done' as const, error: null, conversationId: null, inputs: { topic: '여비' }, expect: '일비', expectMissing: [] as string[], result: '일비', judgeGrade: 'correct' as const, judgeReason: '맞음' };
    const read = async (items: Parameters<typeof batchWorkbook>[0]['items']) => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await batchWorkbook({ name: 'n', fields: [{ key: 'topic', label: '주제' }], origin: 'https://x', items }) as never);
      return wb.getWorksheet('결과')!;
    };
    const labeled = await read([{ ...base, humanGrade: 'partial' }]);
    expect(labeled.getRow(1).values).toContain('사람 판정');
    expect(labeled.getRow(2).values).toContain('일부 맞음');
    expect((await read([base])).getRow(1).values).not.toContain('사람 판정');
  });
  it('연결(원본) — 라우트·목록 셈·화면', () => {
    const route = readFileSync('src/app/api/apps/batches/[id]/route.ts', 'utf8');
    expect(route).toContain('const label = parseHumanLabel(await readJsonObject(request));');
    expect(route).toContain('labelBatchItem(session.user.id, params.id, label.position, label.grade)');
    const lib = readFileSync('src/lib/apps/batches.ts', 'utf8');
    expect(lib).toContain("judge_grade, judge_reason, human_grade', withCount");
    expect(lib).toContain("judge_grade, judge_reason, human_grade').eq('batch_id', id)");
    const panel = readFileSync('src/components/apps/AppBatchPanel.tsx', 'utf8');
    expect(panel).toContain('{batchAgreementSummary(b.agreement)}');
    expect(panel).toContain('<AppBatchItems batchId={b.id}');
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!url)('사람 판정 칸 (0126, 시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
    await db.query(readFileSync('supabase/migrations/0126_app_batch_human_grade.sql', 'utf8'));
  });
  afterAll(async () => { await db?.end(); });

  it('등급 셋만·등급과 때는 짝·마친 줄만', async () => {
    const ok = async (sql: string) => { await db.query('SAVEPOINT s'); try { await db.query(sql); await db.query('RELEASE SAVEPOINT s'); return true; } catch { await db.query('ROLLBACK TO SAVEPOINT s'); return false; } };
    await db.query('BEGIN');
    try {
      const org = await db.query(`INSERT INTO organizations (name) VALUES ('판정 시험 기관') RETURNING id`);
      const dept = await db.query(`INSERT INTO departments (name, slug, organization_id) VALUES ('판정과', 'human-test', $1) RETURNING id`, [org.rows[0].id]);
      const user = await db.query(`INSERT INTO users (email, department_id) VALUES ('human-test@example.invalid', $1) RETURNING id`, [dept.rows[0].id]);
      const agent = await db.query(`INSERT INTO agents (name, department_id, organization_id, tier, visibility) VALUES ('판정 앱', $1, $2, 'official', 'organization') RETURNING id`, [dept.rows[0].id, org.rows[0].id]);
      const b = await db.query(`INSERT INTO app_batches (organization_id, department_id, user_id, agent_id, app_version, name, total) VALUES ($1, $2, $3, $4, 1, '묶음', 2) RETURNING id`,
        [org.rows[0].id, dept.rows[0].id, user.rows[0].id, agent.rows[0].id]);
      const bid = b.rows[0].id;
      expect(await ok(`INSERT INTO app_batch_items (batch_id, position, inputs, status, finished_at, human_grade, human_graded_at) VALUES ('${bid}', 1, '{}', 'done', now(), 'partial', now())`)).toBe(true);
      expect(await ok(`INSERT INTO app_batch_items (batch_id, position, inputs, status, finished_at, human_grade, human_graded_at) VALUES ('${bid}', 2, '{}', 'done', now(), 'great', now())`)).toBe(false);
      expect(await ok(`INSERT INTO app_batch_items (batch_id, position, inputs, status, finished_at, human_grade) VALUES ('${bid}', 3, '{}', 'done', now(), 'correct')`)).toBe(false);
      expect(await ok(`INSERT INTO app_batch_items (batch_id, position, inputs, status, finished_at, human_graded_at) VALUES ('${bid}', 4, '{}', 'done', now(), now())`)).toBe(false);
      expect(await ok(`INSERT INTO app_batch_items (batch_id, position, inputs, status, finished_at, human_grade, human_graded_at) VALUES ('${bid}', 5, '{}', 'failed', now(), 'correct', now())`)).toBe(false);
      expect(await ok(`INSERT INTO app_batch_items (batch_id, position, inputs, status) VALUES ('${bid}', 6, '{}', 'pending')`)).toBe(true);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
