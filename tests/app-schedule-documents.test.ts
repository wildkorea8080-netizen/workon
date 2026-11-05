import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import pg from 'pg';

/**
 * 앱 예약에 문서함 문서(0062, 2026-11-05) — 저장한 문서를 실행 때마다 지금 근거 판으로 읽는다.
 * 가장 비싼 오류: 새 판이 시행됐는데 옛 판으로 돌거나, 시행일 전인 새 판을 미리 쓰거나, 쓸 판이 없는데 조용히 문서 없이 도는 것.
 */

type Result = { data?: unknown; error?: { message: string } | null; count?: number | null };
const state = vi.hoisted(() => ({ results: {} as Record<string, Result[]>, calls: [] as unknown[][] }));
vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => ({ user: { id: 'me', role: 'USER', departmentId: 'dept' } }) }));
vi.mock('@/lib/actor-scope', () => ({
  getActorScope: async () => ({ userId: 'me', isAdmin: false, organizationId: 'org', departmentId: 'dept', visibleDepartmentIds: ['dept'], managedDepartmentIds: [], managesWholeOrganization: false }),
}));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const method of ['select', 'insert', 'update', 'delete', 'eq', 'is', 'lte', 'or', 'order', 'limit']) {
        q[method] = (...args: unknown[]) => { state.calls.push([table, method, ...args]); return q; };
      }
      const next = () => Promise.resolve({ data: null, error: null, count: null, ...(state.results[table]?.shift() ?? {}) });
      q.maybeSingle = () => next();
      q.single = () => next();
      q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => next().then(resolve, reject);
      return q;
    },
  },
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/apps/schedules/route';
import { currentEditionIds, type LibraryDocumentRow } from '@/lib/apps/library-documents';
import { executeSchedule, finishPatch, PAUSED_DOCUMENTS_UNAVAILABLE, type AppScheduleRow, type ExecuteIo } from '@/lib/apps/schedules';
import type { PreparedTurn, TurnEvent } from '@/lib/assistant/types';

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const A = '11111111-0000-4000-8000-00000000000a';
const B = '11111111-0000-4000-8000-00000000000b';
const C = '11111111-0000-4000-8000-00000000000c';
const TODAY = '2026-11-05';

const doc = (over: Partial<LibraryDocumentRow>): LibraryDocumentRow => ({
  id: A, agent_id: AGENT, department_id: 'dept', organization_id: 'org', visibility: 'organization', storage_path: `p/${over.id ?? A}`,
  file_name: '여비규정.hwpx', file_type: 'hwpx', title: '여비 규정', noda_status: 'ready', replaces_id: null, effective_from: null, retired_at: null, ...over,
});

beforeEach(() => { state.results = {}; state.calls = []; });

describe('지금 쓸 판(currentEditionIds)', () => {
  it('그대로면 그대로, 새 판이 시행되면 새 판(사슬 끝까지)', () => {
    expect(currentEditionIds([A], [doc({ id: A })], AGENT, TODAY)).toEqual({ ok: true, ids: [A], changed: false });
    const chain = [doc({ id: A, noda_status: 'retired', retired_at: '2026-10-01' }), doc({ id: B, replaces_id: A, noda_status: 'retired', retired_at: '2026-11-01' }), doc({ id: C, replaces_id: B })];
    expect(currentEditionIds([A], chain, AGENT, TODAY)).toEqual({ ok: true, ids: [C], changed: true });
    // 옛 판 행이 지워졌어도 새 판이 그 id를 가리키면 따라간다
    expect(currentEditionIds([A], [doc({ id: B, replaces_id: A })], AGENT, TODAY)).toEqual({ ok: true, ids: [B], changed: true });
  });

  it('새 판이 시행일 전이거나 읽는 중이면 옛 판 그대로', () => {
    expect(currentEditionIds([A], [doc({ id: A }), doc({ id: B, replaces_id: A, effective_from: '2026-12-01' })], AGENT, TODAY)).toMatchObject({ ids: [A], changed: false });
    expect(currentEditionIds([A], [doc({ id: A }), doc({ id: B, replaces_id: A, noda_status: 'reading' })], AGENT, TODAY)).toMatchObject({ ids: [A], changed: false });
  });

  it('쓸 판이 없으면 실패 — 지움·읽기 실패·다른 비서 문서', () => {
    expect(currentEditionIds([A], [], AGENT, TODAY)).toEqual({ ok: false, missing: [A] });
    expect(currentEditionIds([A], [doc({ id: A, noda_status: 'failed' })], AGENT, TODAY)).toMatchObject({ ok: false });
    expect(currentEditionIds([A], [doc({ id: A, agent_id: 'other' })], AGENT, TODAY)).toMatchObject({ ok: false });
  });

  it('두 문서가 같은 판으로 모이면 하나만, 판 사슬이 돌아도 멈춘다', () => {
    expect(currentEditionIds([A, B], [doc({ id: A, noda_status: 'retired', retired_at: '2026-10-01' }), doc({ id: B, replaces_id: A })], AGENT, TODAY)).toEqual({ ok: true, ids: [B], changed: true });
    const loop = [doc({ id: A, replaces_id: B, noda_status: 'failed' }), doc({ id: B, replaces_id: A, noda_status: 'failed' })];
    expect(currentEditionIds([A], loop, AGENT, TODAY)).toMatchObject({ ok: false });
  });
});

describe('예약 실행이 고른 문서를 싣는다', () => {
  const row = (patch: Partial<AppScheduleRow> = {}): AppScheduleRow => ({
    id: 's1', agent_id: AGENT, user_id: 'u1', department_id: 'd1', organization_id: 'o1', app_version: 3, inputs: { title: '점검' }, document_ids: [A],
    frequency: 'daily', weekday: null, month_day: null, run_hour: 9, run_minute: 0, status: 'active', paused_reason: null,
    next_run_at: '2026-11-03T00:00:00.000Z', claimed_at: null, last_run_at: null, last_status: null, last_error: null, last_conversation_id: null,
    consecutive_failures: 0, run_count: 0, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z', ...patch,
  });
  const events: TurnEvent[] = [{ event: 'meta', data: { conversation_id: 'c1', chunks: [] } }, { event: 'done', data: { usage: { model: 'm', input_tokens: 1, output_tokens: 1 }, title: '점검', number_check: null } }];
  const io = (docs: LibraryDocumentRow[]) => ({
    loadUser: vi.fn(async () => ({ id: 'u1', email: null, role: 'USER', department_id: 'd1', is_active: true, deleted_at: null })),
    prepare: vi.fn(async () => ({ ok: true as const, turn: {} as PreparedTurn })),
    stream: vi.fn(async (_t: PreparedTurn, send: (e: TurnEvent) => void) => { for (const e of events) send(e); }),
    retitle: vi.fn(async () => {}),
    documentsOf: vi.fn(async () => docs),
  }) satisfies ExecuteIo;

  it('지금 판으로 보내고, 새 판으로 따라갔으면 다음부터 그 id로 저장한다', async () => {
    const fake = io([doc({ id: A, noda_status: 'retired', retired_at: '2026-10-01' }), doc({ id: B, replaces_id: A })]);
    const outcome = await executeSchedule(row(), fake);
    expect(outcome).toEqual({ kind: 'completed', conversationId: 'c1', documentIds: [B] });
    expect(fake.documentsOf).toHaveBeenCalledWith(AGENT, 'o1');
    expect((fake.prepare.mock.calls[0] as unknown[])[1]).toMatchObject({ app_document_ids: [B] });
    expect(finishPatch(row(), outcome, Date.parse('2026-11-05T00:00:00Z')).document_ids).toEqual([B]);
  });

  it('그대로면 문서 칸을 고치지 않는다, 문서 없는 예약은 문서를 읽지 않는다', async () => {
    const same = io([doc({ id: A })]);
    const outcome = await executeSchedule(row(), same);
    expect(outcome).toEqual({ kind: 'completed', conversationId: 'c1' });
    expect('document_ids' in finishPatch(row(), outcome, Date.now())).toBe(false);
    const none = io([]);
    await executeSchedule(row({ document_ids: [] }), none);
    expect(none.documentsOf).not.toHaveBeenCalled();
    expect((none.prepare.mock.calls[0] as unknown[])[1]).not.toHaveProperty('app_document_ids');
  });

  it('쓸 판이 없으면 멈춤 — 문서 없이 돌지 않는다(준비를 부르지 않음)', async () => {
    const gone = io([]);
    await expect(executeSchedule(row(), gone)).resolves.toEqual({ kind: 'pause', reason: PAUSED_DOCUMENTS_UNAVAILABLE });
    expect(gone.prepare).not.toHaveBeenCalled();
  });
});

describe('POST /api/apps/schedules — 고른 문서', () => {
  const definition = (attachments: Record<string, unknown>) => ({ schemaVersion: 1, fields: [{ key: 'title', label: '제목', type: 'text', required: true }], output: 'paragraphs', attachments });
  const agentRow = (attachments: Record<string, unknown>) => ({
    id: AGENT, tier: 'department', department_id: 'dept', organization_id: 'org', visibility: 'organization', owner_id: 'me', created_by: 'me',
    is_active: true, is_published: true, deleted_at: null, approval_status: 'approved', version: 3, approval_version: null, name: '점검 앱', app_definition: definition(attachments),
  });
  const created = { id: 's1', agent_id: AGENT, app_version: 3, inputs: { title: '점검' }, document_ids: [A], frequency: 'daily', weekday: null, month_day: null, run_hour: 9, run_minute: 0, status: 'active', paused_reason: null, next_run_at: '2026-11-06T00:00:00.000Z', last_run_at: null, last_status: null, last_error: null, last_conversation_id: null, consecutive_failures: 0, run_count: 0, created_at: '2026-11-05T00:00:00.000Z' };
  const post = (body: Record<string, unknown>) => POST(new NextRequest('http://localhost/api/apps/schedules', { method: 'POST', body: JSON.stringify({ agent_id: AGENT, app_version: 3, inputs: { title: '점검' }, frequency: 'daily', hour: 9, minute: 0, ...body }) }));

  it('파일이 필요한 문서함 앱 — 고를 수 있는 문서와 함께 저장한다', async () => {
    state.results.agents = [{ data: agentRow({ required: true, library: true }) }];
    state.results.documents = [{ data: [doc({ id: A })] }];
    state.results.app_schedules = [{ count: 0 }, { data: created }];
    const res = await post({ document_ids: [A] });
    expect(res.status).toBe(201);
    expect((await res.json()).data.documentCount).toBe(1);
    const inserted = state.calls.find(c => c[0] === 'app_schedules' && c[1] === 'insert')?.[2] as Record<string, unknown>;
    expect(inserted.document_ids).toEqual([A]);
    expect(state.calls).toContainEqual(['documents', 'eq', 'organization_id', 'org']);
  });

  it('거절: 문서 없이 필수 앱, 고를 수 없는 문서, 문서 고르기를 안 받는 앱, 4개, 꼴이 틀림', async () => {
    state.results.agents = [{ data: agentRow({ required: true, library: true }) }];
    expect((await post({})).status).toBe(400);
    state.results.agents = [{ data: agentRow({ required: false, library: true }) }];
    state.results.documents = [{ data: [doc({ id: A, noda_status: 'reading' })] }];
    const unreadable = await post({ document_ids: [A] });
    expect(unreadable.status).toBe(400);
    expect((await unreadable.json()).error.message).toContain('고를 수 없는 문서');
    state.results.agents = [{ data: agentRow({ required: false }) }];
    expect((await post({ document_ids: [A] })).status).toBe(400);
    state.results.agents = [{ data: agentRow({ required: false, library: true }) }];
    expect((await post({ document_ids: [A, B, C, '11111111-0000-4000-8000-00000000000d'] })).status).toBe(400);
    state.results.agents = [{ data: agentRow({ required: false, library: true }) }];
    expect((await post({ document_ids: ['x'] })).status).toBe(400);
    expect(state.calls.some(c => c[0] === 'app_schedules' && c[1] === 'insert')).toBe(false);
  });

  it('파일 필수이고 문서함을 안 받는 앱은 지금처럼 예약할 수 없다', async () => {
    state.results.agents = [{ data: agentRow({ required: true }) }];
    const res = await post({});
    expect((await res.json()).error.message).toBe('파일 첨부가 필수인 앱은 예약할 수 없습니다.');
  });
});

describe('연결 (원본)', () => {
  it('실행 화면이 고른 문서를 예약 폼에 넘기고, 목록이 문서 수를 보인다', () => {
    expect(readFileSync('src/app/apps/run/page.tsx', 'utf8')).toContain('documentIds={pickedDocs}');
    expect(readFileSync('src/components/apps/AppScheduleForm.tsx', 'utf8')).toContain('document_ids: documentIds');
    expect(readFileSync('src/app/apps/schedules/page.tsx', 'utf8')).toContain('s.documentCount > 0');
    expect(readFileSync('src/lib/apps/schedule-spec.ts', 'utf8')).toContain('inputs, document_ids, frequency');
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;

describe.skipIf(!url)('예약 문서 칸 (0062, 시험 DB)', () => {
  let db: pg.Client;
  const sql = () => readFileSync('supabase/migrations/0062_app_schedule_documents.sql', 'utf8');
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });

  it('다시 적용해도 안전, 기본 빈 배열·NOT NULL, 3개 상한 CHECK', async () => {
    await db.query(sql());
    await db.query(sql());
    const col = await db.query("SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = 'app_schedules' AND column_name = 'document_ids'");
    expect(col.rows[0].is_nullable).toBe('NO');
    expect(col.rows[0].column_default).toContain("'{}'");
    const check = await db.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'app_schedules_document_ids_count'");
    expect(check.rows[0].def).toContain('cardinality(document_ids) <= 3');
  });
});
