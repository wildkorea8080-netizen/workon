import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import pg from 'pg';

/** 앱 연동에 문서함 문서(0063, 2026-11-05) — 예약과 같이 만들 때 저장, 호출마다 지금 근거 판, 쓸 판이 없으면 앱을 돌리지 않고 422 */

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
      for (const method of ['select', 'insert', 'update', 'delete', 'eq', 'is', 'lte', 'gt', 'or', 'order', 'limit']) {
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
import { POST } from '@/app/api/apps/webhooks/route';
import { appDocumentChoice } from '@/lib/apps/app-document-choice';
import { executeWebhook, WEBHOOK_DOCUMENTS_UNAVAILABLE, type ClaimedWebhook, type ExecuteWebhookIo } from '@/lib/apps/webhooks';
import type { LibraryDocumentRow } from '@/lib/apps/library-documents';
import type { RunAsInput, RunAsOutcome } from '@/lib/apps/run-as';

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const A = '11111111-0000-4000-8000-00000000000a';
const B = '11111111-0000-4000-8000-00000000000b';
const doc = (over: Partial<LibraryDocumentRow>): LibraryDocumentRow => ({
  id: A, agent_id: AGENT, department_id: 'dept', organization_id: 'org', visibility: 'organization', storage_path: `p/${over.id ?? A}`,
  file_name: '여비규정.hwpx', file_type: 'hwpx', title: '여비 규정', noda_status: 'ready', replaces_id: null, effective_from: null, retired_at: null, ...over,
});

beforeEach(() => { state.results = {}; state.calls = []; });

describe('문서 고르기 검사(appDocumentChoice — 예약·연동 공용)', () => {
  it('꼴·문서함 앱·필수·3개 상한, 안내 글은 예약/연동에 맞춤', () => {
    expect(appDocumentChoice({ required: false, library: true }, [A.toUpperCase()], '연동')).toEqual({ ok: true, ids: [A] });
    expect(appDocumentChoice(undefined, undefined, '연동')).toEqual({ ok: true, ids: [] });
    expect(appDocumentChoice({ required: false }, [A], '연동')).toMatchObject({ ok: false, message: '이 앱은 문서함에서 문서를 고를 수 없습니다.' });
    expect(appDocumentChoice({ required: true, library: true }, [], '연동')).toMatchObject({ ok: false, message: expect.stringContaining('연동할 수 있습니다') });
    expect(appDocumentChoice({ required: true }, [], '예약')).toMatchObject({ ok: false, message: '파일 첨부가 필수인 앱은 예약할 수 없습니다.' });
    expect(appDocumentChoice({ required: false, library: true }, [A, B, '11111111-0000-4000-8000-00000000000c', '11111111-0000-4000-8000-00000000000d'], '연동').ok).toBe(false);
    expect(appDocumentChoice({ required: false, library: true }, [A, A], '연동').ok).toBe(false);
  });
});

describe('연동 실행(executeWebhook)', () => {
  const w: ClaimedWebhook = { id: 'w1', agent_id: AGENT, user_id: 'u1', department_id: 'd1', organization_id: 'o1', app_version: 3 };
  const io = (stored: string[], docs: LibraryDocumentRow[]) => ({
    documentIdsOf: vi.fn(async () => stored),
    documentsOf: vi.fn(async () => docs),
    saveDocumentIds: vi.fn(async () => {}),
    run: vi.fn(async (_input: RunAsInput): Promise<RunAsOutcome> => ({ kind: 'completed', conversationId: 'c1' })),
  }) satisfies ExecuteWebhookIo;

  it('지금 판으로 실행하고, 새 판으로 따라갔으면 다음부터 그 id로 저장한다', async () => {
    const fake = io([A], [doc({ id: A, noda_status: 'retired', retired_at: '2026-10-01' }), doc({ id: B, replaces_id: A })]);
    await expect(executeWebhook(w, { title: 'x' }, fake)).resolves.toEqual({ kind: 'completed', conversationId: 'c1' });
    expect(fake.run.mock.calls[0][0]).toMatchObject({ agentId: AGENT, inputs: { title: 'x' }, documentIds: [B] });
    expect(fake.documentsOf).toHaveBeenCalledWith(AGENT, 'o1');
    expect(fake.saveDocumentIds).toHaveBeenCalledWith('w1', [B]);
  });

  it('그대로면 저장하지 않고, 문서 없는 연동은 문서를 읽지 않는다', async () => {
    const same = io([A], [doc({ id: A })]);
    await executeWebhook(w, {}, same);
    expect(same.saveDocumentIds).not.toHaveBeenCalled();
    const none = io([], []);
    await executeWebhook(w, {}, none);
    expect(none.documentsOf).not.toHaveBeenCalled();
    expect(none.run.mock.calls[0]?.[0].documentIds).toBeUndefined();
  });

  it('쓸 판이 없으면 앱을 돌리지 않고 422 — 실패한 실행 뒤에도 새 판을 저장하지 않는다', async () => {
    const gone = io([A], []);
    await expect(executeWebhook(w, {}, gone)).resolves.toEqual({ kind: 'rejected', status: 422, message: WEBHOOK_DOCUMENTS_UNAVAILABLE });
    expect(gone.run).not.toHaveBeenCalled();
    const failed = io([A], [doc({ id: A, noda_status: 'retired', retired_at: '2026-10-01' }), doc({ id: B, replaces_id: A })]);
    failed.run.mockResolvedValueOnce({ kind: 'failed', error: 'x', conversationId: null });
    await executeWebhook(w, {}, failed);
    expect(failed.saveDocumentIds).not.toHaveBeenCalled();
  });
});

describe('POST /api/apps/webhooks — 고른 문서', () => {
  const agentRow = (attachments: Record<string, unknown>) => ({
    id: AGENT, tier: 'department', department_id: 'dept', organization_id: 'org', visibility: 'organization', owner_id: 'me', created_by: 'me',
    is_active: true, is_published: true, deleted_at: null, approval_status: 'approved', version: 3, approval_version: null, name: '접수 앱',
    app_definition: { schemaVersion: 1, fields: [{ key: 'title', label: '제목', type: 'text', required: true }], output: 'paragraphs', attachments },
  });
  const created = { id: 'w1', agent_id: AGENT, app_version: 3, document_ids: [A], name: '접수', token_prefix: 'wo_wh_abcdef', status: 'active', expires_at: '2027-01-01T00:00:00.000Z', revoked_at: null, last_used_at: null, use_count: 0, last_status: null, last_error: null, last_conversation_id: null, created_at: '2026-11-05T00:00:00.000Z' };
  const post = (body: Record<string, unknown>) => POST(new NextRequest('http://localhost/api/apps/webhooks', { method: 'POST', body: JSON.stringify({ agent_id: AGENT, app_version: 3, name: '접수', expiry_days: 90, ...body }) }));

  it('파일이 필요한 문서함 앱 — 고를 수 있는 문서와 함께 만든다', async () => {
    state.results.agents = [{ data: agentRow({ required: true, library: true }) }];
    state.results.documents = [{ data: [doc({ id: A })] }];
    state.results.app_webhooks = [{ count: 0 }, { data: created }];
    const res = await post({ document_ids: [A] });
    expect(res.status).toBe(201);
    expect((await res.json()).data.webhook.documentCount).toBe(1);
    const inserted = state.calls.find(c => c[0] === 'app_webhooks' && c[1] === 'insert')?.[2] as Record<string, unknown>;
    expect(inserted.document_ids).toEqual([A]);
  });

  it('거절: 문서 없이 필수 앱, 고를 수 없는 문서, 파일 필수 비문서함 앱은 예전 문구', async () => {
    state.results.agents = [{ data: agentRow({ required: true, library: true }) }];
    expect((await post({})).status).toBe(400);
    state.results.agents = [{ data: agentRow({ required: false, library: true }) }];
    state.results.documents = [{ data: [doc({ id: A, visibility: 'department', department_id: 'secret' })] }];
    expect((await post({ document_ids: [A] })).status).toBe(400);
    state.results.agents = [{ data: agentRow({ required: true }) }];
    expect((await (await post({})).json()).error.message).toBe('파일 첨부가 필수인 앱은 연동할 수 없습니다.');
    expect(state.calls.some(c => c[0] === 'app_webhooks' && c[1] === 'insert')).toBe(false);
  });
});

describe('연결 (원본)', () => {
  it('실행 화면이 고른 문서를 연동 폼에 넘기고, 목록이 문서 수를 보인다, 예약도 같은 검사를 쓴다', () => {
    expect(readFileSync('src/app/apps/run/page.tsx', 'utf8')).toContain('definition={definition} documentIds={pickedDocs} disabled={running}');
    expect(readFileSync('src/components/apps/AppWebhookForm.tsx', 'utf8')).toContain('document_ids: documentIds');
    expect(readFileSync('src/app/apps/webhooks/page.tsx', 'utf8')).toContain('w.documentCount > 0');
    expect(readFileSync('src/lib/apps/webhook-spec.ts', 'utf8')).toContain('app_version, document_ids, name');
    expect(readFileSync('src/app/api/apps/schedules/route.ts', 'utf8')).toContain("appDocumentChoice(definition.value.attachments, body.document_ids, '예약')");
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;

describe.skipIf(!url)('연동 문서 칸 (0063, 시험 DB)', () => {
  let db: pg.Client;
  const sql = () => readFileSync('supabase/migrations/0063_app_webhook_documents.sql', 'utf8');
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });

  it('다시 적용해도 안전, 기본 빈 배열·NOT NULL, 3개 상한 CHECK', async () => {
    await db.query(sql());
    await db.query(sql());
    const col = await db.query("SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = 'app_webhooks' AND column_name = 'document_ids'");
    expect(col.rows[0].is_nullable).toBe('NO');
    expect(col.rows[0].column_default).toContain("'{}'");
    const check = await db.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'app_webhooks_document_ids_count'");
    expect(check.rows[0].def).toContain('cardinality(document_ids) <= 3');
  });
});
