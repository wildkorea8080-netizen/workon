// tests/batch-0325.test.ts
// 입력형 앱 일괄 실행에 문서함 문서(2026-11-26, 0131) — 묶음에 고른 문서를 두고 줄마다 지금 근거 판으로 함께 실행한다.
import { readFileSync } from 'fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

import { BATCH_DOCUMENTS_GONE_STATUS, BATCH_DOCUMENTS_UNAVAILABLE, BATCH_FILES_OR_DOCUMENTS } from '@/lib/apps/batch-spec';
import { runBatchItem, runDueBatchItems, type BatchDeps, type BatchItemRun, type BatchRunIo } from '@/lib/apps/batches';
import { appDocumentChoice } from '@/lib/apps/app-document-choice';
import type { LibraryDocumentRow } from '@/lib/apps/library-documents';
import type { RunAsOutcome } from '@/lib/apps/run-as';
import { BATCH_FILE_DOCUMENTS_TOO_MANY, batchDocumentsNote, previewFileBatch } from '@/components/apps/AppBatchPanel';
import type { AppDefinition } from '@/lib/apps/definition';

const OLD = 'aaaaaaaa-0000-4000-8000-000000000001';
const NEW = 'aaaaaaaa-0000-4000-8000-000000000002';
const AGENT = 'a1';
const doc = (id: string, over: Partial<LibraryDocumentRow> = {}): LibraryDocumentRow => ({
  id, agent_id: AGENT, department_id: 'd1', organization_id: 'o1', visibility: 'organization', storage_path: `p/${id}.pdf`, file_name: `${id}.pdf`, file_type: 'pdf', title: null, noda_status: 'ready', replaces_id: null, effective_from: null, retired_at: null, ...over,
} as LibraryDocumentRow);
const batch = { id: 'b1', organization_id: 'o1', department_id: 'd1', user_id: 'u1', agent_id: AGENT, app_version: 2, status: 'running' as const };
const item = (over: Partial<BatchItemRun['batch']> = {}): BatchItemRun => ({ id: 'i1', batch_id: 'b1', position: 1, inputs: { topic: 'q' }, status: 'pending', attempts: 0, claimed_at: null, batch: { ...batch, ...over } });

function io(rows: LibraryDocumentRow[] | (() => never)) {
  const runAs = vi.fn(async (): Promise<RunAsOutcome> => ({ kind: 'completed', conversationId: 'c', messageId: 'm' }));
  const documentsOf = vi.fn(async () => (typeof rows === 'function' ? rows() : rows));
  return { io: { files: {} as BatchRunIo['files'], runAs, documentsOf } as BatchRunIo, runAs, documentsOf };
}

describe('줄 실행 — 고른 문서를 지금 판으로', () => {
  it('새 판이 나왔으면 새 판으로, 고른 문서가 없으면 문서를 읽지 않는다', async () => {
    const t = io([doc(OLD), doc(NEW, { replaces_id: OLD })]);
    await runBatchItem(item({ document_ids: [OLD] }), 9e12, t.io);
    expect(t.runAs).toHaveBeenCalledWith(expect.objectContaining({ documentIds: [NEW], agentId: AGENT, appVersion: 2 }));
    expect(t.documentsOf).toHaveBeenCalledWith(AGENT, 'o1');
    const none = io([]);
    await runBatchItem(item(), 9e12, none.io);
    expect(none.documentsOf).not.toHaveBeenCalled();
    expect(none.runAs.mock.calls[0]).not.toEqual([expect.objectContaining({ documentIds: expect.anything() })]);
  });
  it('쓸 판이 없으면 410(묶음 멈춤), 못 읽으면 그 줄만 다시', async () => {
    const gone = io([doc(OLD, { noda_status: 'retired', retired_at: '2026-11-01T00:00:00Z' })]);
    expect(await runBatchItem(item({ document_ids: [OLD] }), 9e12, gone.io)).toEqual({ kind: 'rejected', status: BATCH_DOCUMENTS_GONE_STATUS, message: BATCH_DOCUMENTS_UNAVAILABLE });
    expect(gone.runAs).not.toHaveBeenCalled();
    const broken = io(() => { throw new Error('db'); });
    expect(await runBatchItem(item({ document_ids: [OLD] }), 9e12, broken.io)).toMatchObject({ kind: 'failed', conversationId: null });
  });
  it('실행기 — 410은 묶음을 멈추고 까닭을 남긴다', async () => {
    const stopped: string[] = [];
    const d: BatchDeps = {
      now: () => 0, openItems: async () => [item({ document_ids: [OLD] })], claim: async () => true,
      run: async () => ({ kind: 'rejected', status: BATCH_DOCUMENTS_GONE_STATUS, message: BATCH_DOCUMENTS_UNAVAILABLE }),
      finishItem: async () => {}, stop: async (_id, reason) => { stopped.push(reason); return true; }, settle: async () => false, log: async () => {},
    };
    expect(await runDueBatchItems(d)).toMatchObject({ stopped: 1 });
    expect(stopped).toEqual([BATCH_DOCUMENTS_UNAVAILABLE]);
  });
});

describe('만들 때 검사', () => {
  it('문서 고르기를 받는 앱만, 파일마다 한 건이면 파일 하나와 합쳐 3개', () => {
    expect(appDocumentChoice({ required: false, library: true }, [OLD], '일괄 실행')).toEqual({ ok: true, ids: [OLD] });
    expect(appDocumentChoice({ required: false }, [OLD], '일괄 실행')).toMatchObject({ ok: false, message: expect.stringContaining('고를 수 없습니다') });
    expect(appDocumentChoice({ required: true, library: true }, [OLD, NEW, 'aaaaaaaa-0000-4000-8000-000000000003'], '일괄 실행', 1)).toMatchObject({ ok: false, message: expect.stringContaining('일괄 실행에는 파일·문서를 합쳐 3개') });
    // 파일 필수 앱도 문서를 고르면 표로(만들기 검사는 아래 연결)
    expect(appDocumentChoice({ required: true, library: true }, [OLD], '일괄 실행')).toEqual({ ok: true, ids: [OLD] });
  });
  it('연결 — 만들기·다시 실행·실행기·화면', () => {
    const lib = readFileSync('src/lib/apps/batches.ts', 'utf8');
    expect(lib).toContain("appDocumentChoice(definition.value.attachments, b.document_ids, '일괄 실행', fileMode ? 1 : 0)");
    expect(lib).toContain('const verified = await verifyChosenDocuments(agent.id, actor, documentIds);');
    expect(lib).toMatch(/\.\.\.\(documentIds\.length \? \{ document_ids: documentIds \} : \{\}\),\r?\n {2}\}\)\.select\(BATCH_COLUMNS\)/);
    expect(lib).toContain("if (documentIds.length && opts.source === 'webhook')");
    expect(lib).toContain('const resolved = currentEditionIds(batch.document_ids, rows, batch.agent_id);');
    expect(lib).toContain("judge, document_ids')");
    expect(lib).toContain('if (outcome.status === BATCH_DOCUMENTS_GONE_STATUS) return BATCH_DOCUMENTS_UNAVAILABLE;');
    expect(BATCH_FILES_OR_DOCUMENTS).toContain('문서함에서 문서를 골라');
    expect(readFileSync('src/app/apps/run/page.tsx', 'utf8')).toContain('documentIds={pickedDocs} disabled={running} />');
    const panel = readFileSync('src/components/apps/AppBatchPanel.tsx', 'utf8');
    expect(panel).toContain('...(documentIds.length ? { document_ids: documentIds } : {})');
    expect(panel).toContain("const filesOnly = Boolean(definition.attachments?.required) && !documentIds.length;");
  });
  it('화면 — 파일마다 한 건은 문서 둘까지, 안내 글', () => {
    const def: AppDefinition = { schemaVersion: 1, output: 'bullets', fields: [{ key: 'topic', label: '주제', type: 'text', required: false }], attachments: { required: false, library: true } };
    expect(previewFileBatch(def, '', 2, 3)).toEqual({ ok: false, errors: [BATCH_FILE_DOCUMENTS_TOO_MANY] });
    expect(previewFileBatch(def, '', 2, 2)).toMatchObject({ ok: true });
    expect(batchDocumentsNote(2)).toContain('문서 2개를 줄마다');
  });
});

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!dbUrl)('0131 — 칸·CHECK(시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(dbUrl!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('3개까지·두 번 적용해도 안전', async () => {
    const sql = readFileSync('supabase/migrations/0131_app_batch_documents.sql', 'utf8');
    await db.query('BEGIN');
    try {
      await db.query(sql); await db.query(sql);
      const col = await db.query(`SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name='app_batches' AND column_name='document_ids'`);
      expect(col.rows[0]).toMatchObject({ data_type: 'ARRAY', is_nullable: 'NO' });
      const chk = await db.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='app_batches_document_ids_count'`);
      expect(chk.rows[0].d).toContain('3');
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
