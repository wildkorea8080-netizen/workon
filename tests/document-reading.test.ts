import { describe, expect, it, vi } from 'vitest';
import {
  READ_GIVE_UP_MS,
  READ_KICK_AFTER_MS,
  READ_LIMIT_REASON,
  READ_SERVER_FAILED_REASON,
  READ_TIMEOUT_REASON,
  RECONCILE_BUDGET_MS,
  RECONCILE_LIST_TIMEOUT_MS,
  decideReadState,
  readDocument,
  reconcileReading,
  startReadingFields,
  type ReadingDeps,
  type ReadingRow,
  type ReadingStore,
  type StoredDocument,
} from '@/lib/document-reading';
import { MAX_UPLOAD_BYTES } from '@/lib/file-types';
import { NodaError, nodaFilename, nodaTenant, type NodaListing, type NodaUploadResult } from '@/lib/noda';

const AGENT = '11111111-2222-4333-8444-555555555555';
const AGENT_B = '21111111-2222-4333-8444-555555555555';
const DOC = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const iso = (ms: number) => new Date(ms).toISOString();

function row(over: Partial<ReadingRow & { agent_id: string | null }> = {}): ReadingRow & { agent_id: string | null } {
  return {
    id: DOC,
    agent_id: AGENT,
    noda_status: 'reading',
    noda_filename: 'F',
    noda_read_started_at: iso(0),
    noda_last_attempt_at: null,
    created_at: iso(0),
    ...over,
  };
}
const listing = (documents: string[], receiving: string[] = [], failed: NodaListing['failed'] = []): NodaListing => ({
  documents: documents.map((filename) => ({ filename })),
  receiving: receiving.map((filename) => ({ filename, seconds: 5 })),
  failed,
});

describe('decideReadState — 비동기 넣기의 결과(2026-10-24)', () => {
  it('documents에 있지만 readable:false면 unreadable — ready로 보지 않는다', () => {
    const l: NodaListing = { documents: [{ filename: 'F', readable: false, reason: 'PASSWORD_PROTECTED' }], receiving: [], failed: [] };
    expect(decideReadState(row(), l, 60_000)).toBe('unreadable');
  });
  it('readable 칸이 없는 옛 응답은 지금처럼 ready', () => {
    expect(decideReadState(row(), listing(['F']), 60_000)).toBe('ready');
  });
  it('마지막으로 보낸 뒤의 실패(failed)는 noda_failed', () => {
    const r = row({ noda_last_attempt_at: iso(10_000) });
    const l = listing([], [], [{ filename: 'F', status: 403, error: '한도', at: iso(20_000) }]);
    expect(decideReadState(r, l, 30_000)).toBe('noda_failed');
  });
  it('마지막으로 보내기 전의 옛 실패는 보지 않는다', () => {
    const r = row({ noda_last_attempt_at: iso(50_000) });
    const l = listing([], [], [{ filename: 'F', status: 500, error: 'x', at: iso(20_000) }]);
    expect(decideReadState(r, l, 60_000)).toBe('reading');
  });
  it('받는 중(receiving)이 실패보다 먼저다', () => {
    const l = listing([], ['F'], [{ filename: 'F', status: 500, error: 'x', at: iso(20_000) }]);
    expect(decideReadState(row(), l, 30_000)).toBe('reading');
  });
});

describe('decideReadState', () => {
  it('receiving에 있으면 reading — documents에도 옛 판이 있어도', () => {
    expect(decideReadState(row(), listing(['F'], ['F']), 60_000)).toBe('reading');
  });
  it('documents에 있으면 ready', () => {
    expect(decideReadState(row(), listing(['F']), 60_000)).toBe('ready');
  });
  it('둘 다 없고 마지막 시도가 2분 넘었으면 kick', () => {
    expect(decideReadState(row(), listing([]), READ_KICK_AFTER_MS + 1)).toBe('kick');
  });
  it('둘 다 없어도 2분 전이면 reading', () => {
    expect(decideReadState(row(), listing([]), READ_KICK_AFTER_MS - 1)).toBe('reading');
  });
  it('마지막 시도가 있으면 그 시각부터 2분을 센다(시작 시각이 아니라)', () => {
    const r = row({ noda_last_attempt_at: iso(300_000) });
    expect(decideReadState(r, listing([]), 300_000 + READ_KICK_AFTER_MS - 1)).toBe('reading');
    expect(decideReadState(r, listing([]), 300_000 + READ_KICK_AFTER_MS + 1)).toBe('kick');
  });
  it('시작 10분이 지났고 documents에 없으면 give_up', () => {
    expect(decideReadState(row(), listing([]), READ_GIVE_UP_MS + 1)).toBe('give_up');
  });
  it('10분이 지나도 NODA가 아직 받는 중이면 reading', () => {
    expect(decideReadState(row(), listing([], ['F']), READ_GIVE_UP_MS + 1)).toBe('reading');
  });
  it('10분이 지나도 documents에 있으면 ready', () => {
    expect(decideReadState(row(), listing(['F']), READ_GIVE_UP_MS + 1)).toBe('ready');
  });
  it('시작·시도 시각이 없으면 만든 때를 기준으로 한다', () => {
    const r = row({ noda_read_started_at: null, noda_last_attempt_at: null, created_at: iso(0) });
    expect(decideReadState(r, listing([]), READ_KICK_AFTER_MS + 1)).toBe('kick');
    expect(decideReadState(r, listing([]), READ_GIVE_UP_MS + 1)).toBe('give_up');
  });
});

describe('startReadingFields', () => {
  it('읽기 시작 칸을 모은다 — 마지막 시도는 비운다', () => {
    const now = new Date(5000);
    expect(startReadingFields(now)).toEqual({
      noda_status: 'reading',
      noda_read_started_at: now.toISOString(),
      noda_last_attempt_at: null,
      noda_reason: null,
    });
  });
});

// ── 가짜 의존성 ────────────────────────────────────────────────

interface World {
  docs: Map<string, StoredDocument>;
  files: Map<string, Uint8Array | null>;
  uploads: { tenant: string; filename: string; bytes: Uint8Array }[];
  deletes: { tenant: string; filename: string }[];
  listCalls: string[];
  listOpts: unknown[];
  /** 목록 호출 한 번이 시계를 얼마나 보내는지(느린 NODA 흉내) */
  listDelayMs: number;
  logs: Record<string, unknown>[];
  clock: { t: number };
  upload: () => Promise<NodaUploadResult>;
  lists: Map<string, NodaListing | Error>;
  deleteError: Error | null;
}

function doc(over: Partial<StoredDocument> = {}): StoredDocument {
  return {
    id: DOC,
    agent_id: AGENT,
    storage_path: 'documents/p.pdf',
    file_name: '예산(최종).PDF',
    noda_status: 'reading',
    noda_reason: null,
    noda_filename: nodaFilename(DOC, '예산(최종).PDF'),
    noda_doc_id: null,
    noda_read_started_at: iso(0),
    noda_last_attempt_at: null,
    noda_read_at: null,
    created_at: iso(0),
    ...over,
  };
}

function makeWorld(docs: StoredDocument[] = [doc()]): { w: World; deps: ReadingDeps } {
  const w: World = {
    docs: new Map(docs.map((d) => [d.id, d])),
    files: new Map([['documents/p.pdf', new Uint8Array([1, 2, 3])]]),
    uploads: [],
    deletes: [],
    listCalls: [],
    listOpts: [],
    listDelayMs: 0,
    logs: [],
    clock: { t: 1_000_000 },
    upload: async () => ({
      tenant: '', filename: '', bytes: 3, stored: true, doc_id: 'n-1', readable: true, reason: null, chunks: 4,
    }),
    lists: new Map(),
    deleteError: null,
  };
  const store: ReadingStore = {
    async getRow(id) {
      const d = w.docs.get(id);
      return d ? { ...d } : null;
    },
    async restart(id, fields) {
      const d = w.docs.get(id);
      if (!d || d.noda_status !== 'failed') return false;
      Object.assign(d, fields);
      return true;
    },
    async claim(id, nowIso, cutoffIso) {
      const d = w.docs.get(id);
      if (!d || d.noda_status !== 'reading') return false;
      if (d.noda_last_attempt_at !== null && d.noda_last_attempt_at >= cutoffIso) return false;
      d.noda_last_attempt_at = nowIso;
      return true;
    },
    async finish(id, patch) {
      const d = w.docs.get(id);
      if (!d || d.noda_status !== 'reading') return false;
      Object.assign(d, patch);
      return true;
    },
    async download(path) {
      return w.files.get(path) ?? null;
    },
  };
  const deps: ReadingDeps = {
    store,
    noda: {
      async uploadDocument(input) {
        w.uploads.push(input);
        return w.upload();
      },
      async listDocuments(tenant, opts) {
        w.listCalls.push(tenant);
        w.listOpts.push(opts);
        w.clock.t += w.listDelayMs;
        const v = w.lists.get(tenant) ?? listing([]);
        if (v instanceof Error) throw v;
        return v;
      },
      async deleteDocument(tenant, filename) {
        w.deletes.push({ tenant, filename });
        if (w.deleteError) throw w.deleteError;
        return { deleted: true };
      },
    },
    now: () => w.clock.t,
    log: async (p) => {
      w.logs.push(p as unknown as Record<string, unknown>);
    },
    tenantOf: (r) => (r.agent_id ? nodaTenant(r.agent_id) : null),
  };
  return { w, deps };
}

describe('readDocument', () => {
  it('Supabase 원본을 NODA로 보내고 readable이면 ready', async () => {
    const { w, deps } = makeWorld();
    const out = await readDocument(DOC, {}, deps);
    expect(out.status).toBe('ready');
    expect(w.uploads).toHaveLength(1);
    expect(w.uploads[0].tenant).toBe(nodaTenant(AGENT));
    expect(w.uploads[0].filename).toBe(`${DOC}__예산(최종).PDF`);
    expect(Array.from(w.uploads[0].bytes)).toEqual([1, 2, 3]);
    const d = w.docs.get(DOC)!;
    expect(d.noda_status).toBe('ready');
    expect(d.noda_doc_id).toBe('n-1');
    expect(d.noda_read_at).toBe(iso(w.clock.t));
  });

  it('readable:false면 unreadable + reason(200자에서 자름)', async () => {
    const { w, deps } = makeWorld();
    w.upload = async () => ({
      tenant: '', filename: '', bytes: 3, stored: true, doc_id: null, readable: false, reason: '가'.repeat(300), chunks: 0,
    });
    const out = await readDocument(DOC, {}, deps);
    expect(out.status).toBe('unreadable');
    expect(out.reason).toBe('가'.repeat(200));
    const d = w.docs.get(DOC)!;
    expect(d.noda_status).toBe('unreadable');
    expect(d.noda_reason).toBe('가'.repeat(200));
  });

  it('같은 문서를 동시에 두 번 불러도 NODA 업로드는 한 번', async () => {
    const { w, deps } = makeWorld();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    w.upload = async () => {
      await gate;
      return { tenant: '', filename: '', bytes: 3, stored: true, doc_id: 'n-1', readable: true, reason: null, chunks: 1 };
    };
    const a = readDocument(DOC, {}, deps);
    const b = readDocument(DOC, {}, deps);
    release();
    const outs = await Promise.all([a, b]);
    expect(outs.map((o) => o.status).sort()).toEqual(['busy', 'ready']);
    expect(w.uploads).toHaveLength(1);
  });

  it('읽기가 끝났는데 행이 지워졌으면 NODA 사본을 지운다', async () => {
    const { w, deps } = makeWorld();
    w.upload = async () => {
      w.docs.delete(DOC); // 읽는 도중 직원이 지움
      return { tenant: '', filename: '', bytes: 3, stored: true, doc_id: 'n-1', readable: true, reason: null, chunks: 1 };
    };
    const out = await readDocument(DOC, {}, deps);
    expect(out.status).toBe('not_found');
    expect(w.deletes).toEqual([{ tenant: nodaTenant(AGENT), filename: nodaFilename(DOC, '예산(최종).PDF') }]);
  });

  it('읽는 도중 deleting으로 바뀌었으면 ready로 덮지 않고 NODA 사본도 건드리지 않는다', async () => {
    const { w, deps } = makeWorld();
    w.upload = async () => {
      w.docs.get(DOC)!.noda_status = 'deleting';
      return { tenant: '', filename: '', bytes: 3, stored: true, doc_id: 'n-1', readable: true, reason: null, chunks: 1 };
    };
    const out = await readDocument(DOC, {}, deps);
    expect(out.status).toBe('deleting');
    expect(w.docs.get(DOC)!.noda_status).toBe('deleting');
    expect(w.deletes).toHaveLength(0);
  });

  it('사본을 지우다 실패해도 던지지 않는다', async () => {
    const { w, deps } = makeWorld();
    w.deleteError = new NodaError('NODA 503', 'http', 503);
    w.upload = async () => {
      w.docs.delete(DOC);
      return { tenant: '', filename: '', bytes: 3, stored: true, doc_id: 'n-1', readable: true, reason: null, chunks: 1 };
    };
    await expect(readDocument(DOC, {}, deps)).resolves.toEqual({ status: 'not_found' });
    expect(w.logs).toHaveLength(1);
  });

  it('NODA 실패 기록에 응답의 요청 번호(X-Request-Id)가 실린다 — NODA 문의용', async () => {
    const { w, deps } = makeWorld();
    w.upload = async () => {
      throw new NodaError('NODA 500: boom', 'http', 500, null, 'req-77');
    };
    await readDocument(DOC, {}, deps);
    const log = w.logs[0] as { details: Record<string, unknown> };
    expect(log.details).toMatchObject({ document_id: DOC, code: 'http', status: 500, request_id: 'req-77' });
  });

  it('NodaError면 reading 그대로 두고 던지지 않는다', async () => {
    const { w, deps } = makeWorld();
    w.upload = async () => {
      throw new NodaError('NODA 503: boom', 'http', 503);
    };
    const out = await readDocument(DOC, {}, deps);
    expect(out.status).toBe('reading');
    expect(w.docs.get(DOC)!.noda_status).toBe('reading');
    expect(w.logs).toHaveLength(1);
    const log = w.logs[0] as { level: string; category: string; details: Record<string, unknown> };
    expect(log.level).toBe('warning');
    expect(log.category).toBe('api');
    expect(log.details).toEqual({ document_id: DOC, code: 'http', status: 503, request_id: null });
    expect(JSON.stringify(w.logs)).not.toContain('예산'); // 파일 이름을 남기지 않는다
  });

  it('NodaError로 끝났는데 그 사이 행이 지워졌으면 NODA 사본을 지운다(고아를 남기지 않음)', async () => {
    const { w, deps } = makeWorld();
    w.upload = async () => {
      w.docs.delete(DOC);
      throw new NodaError('NODA 503', 'http', 503);
    };
    const out = await readDocument(DOC, {}, deps);
    expect(out).toEqual({ status: 'not_found' });
    expect(w.deletes).toEqual([{ tenant: nodaTenant(AGENT), filename: nodaFilename(DOC, '예산(최종).PDF') }]);
  });

  it('NodaError + 행 사라짐 + 사본 지우기도 실패해도 던지지 않는다', async () => {
    const { w, deps } = makeWorld();
    w.deleteError = new NodaError('NODA 503', 'http', 503);
    w.upload = async () => {
      w.docs.delete(DOC);
      throw new NodaError('NODA 503', 'http', 503);
    };
    await expect(readDocument(DOC, {}, deps)).resolves.toEqual({ status: 'not_found' });
  });

  it.each([401, 403])('NODA %i(키 문제)는 운영 기록 critical', async (status) => {
    const { w, deps } = makeWorld();
    w.upload = async () => {
      throw new NodaError(`NODA ${status}`, 'http', status);
    };
    await readDocument(DOC, {}, deps);
    expect((w.logs[0] as { level: string }).level).toBe('critical');
  });

  it('NODA가 알려 준 이유에서 문서 id 앞부분을 떼고 저장한다', async () => {
    const { w, deps } = makeWorld();
    w.upload = async () => ({
      tenant: '', filename: '', bytes: 3, stored: true, doc_id: null, readable: false,
      reason: `${DOC}__예산(최종).PDF: 암호가 걸린 문서입니다`, chunks: 0,
    });
    const out = await readDocument(DOC, {}, deps);
    expect(out.reason).toBe('예산(최종).PDF: 암호가 걸린 문서입니다');
    expect(w.docs.get(DOC)!.noda_reason).toBe('예산(최종).PDF: 암호가 걸린 문서입니다');
  });

  it('원본이 20MB를 넘으면 NODA로 보내지 않고 unreadable', async () => {
    const { w, deps } = makeWorld();
    w.files.set('documents/p.pdf', new Uint8Array(MAX_UPLOAD_BYTES + 1));
    const out = await readDocument(DOC, {}, deps);
    expect(out.status).toBe('unreadable');
    expect(w.uploads).toHaveLength(0);
    expect(w.docs.get(DOC)!.noda_status).toBe('unreadable');
    expect(w.docs.get(DOC)!.noda_reason).toMatch(/20MB/);
  });

  it('원본을 저장소에서 못 가져오면 failed — 다시 시도할 수 있게', async () => {
    const { w, deps } = makeWorld();
    w.files.set('documents/p.pdf', null);
    const out = await readDocument(DOC, {}, deps);
    expect(out.status).toBe('failed');
    expect(w.uploads).toHaveLength(0);
    expect(w.docs.get(DOC)!.noda_status).toBe('failed');
  });

  it('retry는 failed만 받는다 — 시작 시각을 새로 찍고 읽는다', async () => {
    const { w, deps } = makeWorld([doc({ noda_status: 'failed', noda_reason: '옛 이유', noda_last_attempt_at: iso(5) })]);
    const out = await readDocument(DOC, { retry: true }, deps);
    expect(out.status).toBe('ready');
    const d = w.docs.get(DOC)!;
    expect(d.noda_read_started_at).toBe(iso(w.clock.t));
    expect(d.noda_reason).toBeNull();
    expect(w.uploads).toHaveLength(1);
  });

  it('retry가 아니면 failed 문서는 읽지 않는다', async () => {
    const { w, deps } = makeWorld([doc({ noda_status: 'failed' })]);
    const out = await readDocument(DOC, {}, deps);
    expect(out.status).toBe('failed');
    expect(w.uploads).toHaveLength(0);
  });

  it.each(['unreadable', 'ready'] as const)('retry는 %s를 바꾸지 않는다', async (status) => {
    const { w, deps } = makeWorld([doc({ noda_status: status, noda_reason: '그대로' })]);
    const before = { ...w.docs.get(DOC)! };
    const out = await readDocument(DOC, { retry: true }, deps);
    expect(out.status).toBe(status);
    expect(w.uploads).toHaveLength(0);
    expect(w.docs.get(DOC)).toEqual(before);
  });

  it('비서 없는 문서는 보내지 않는다', async () => {
    const { w, deps } = makeWorld([doc({ agent_id: null })]);
    const out = await readDocument(DOC, {}, deps);
    expect(out).toEqual({ status: 'not_found' });
    expect(w.uploads).toHaveLength(0);
  });

  it('없는 문서·옮기기 전 문서(noda_status NULL)는 not_found', async () => {
    const { w, deps } = makeWorld([doc({ noda_status: null })]);
    expect((await readDocument(DOC, {}, deps)).status).toBe('not_found');
    expect((await readDocument('00000000-0000-4000-8000-000000000000', {}, deps)).status).toBe('not_found');
    expect(w.uploads).toHaveLength(0);
  });

  it('2분 안에 다시 부르면 busy, 2분이 지나면 다시 보낸다(replace=1이라 안전)', async () => {
    const { w, deps } = makeWorld();
    w.upload = async () => {
      throw new NodaError('NODA 503', 'http', 503);
    };
    expect((await readDocument(DOC, {}, deps)).status).toBe('reading');
    w.clock.t += READ_KICK_AFTER_MS - 1;
    expect((await readDocument(DOC, {}, deps)).status).toBe('busy');
    expect(w.uploads).toHaveLength(1);
    w.clock.t += 2;
    await readDocument(DOC, {}, deps);
    expect(w.uploads).toHaveLength(2);
  });
});

describe('비동기 넣기(async=1)', () => {
  it('readDocument는 async로 보내고, NODA가 202로 받으면 reading으로 둔다', async () => {
    const { w, deps } = makeWorld();
    w.upload = async () => ({ tenant: '', filename: '', bytes: 3, stored: false, doc_id: null, readable: false, reason: null, chunks: 0, accepted: true });
    const out = await readDocument(DOC, {}, deps);
    expect(out).toEqual({ status: 'reading' });
    expect((w.uploads[0] as { async?: boolean }).async).toBe(true);
    expect(w.docs.get(DOC)!.noda_status).toBe('reading');
    expect(w.docs.get(DOC)!.noda_last_attempt_at).not.toBeNull();
  });

  it('맞추기: readable:false는 unreadable(이유의 문서 id 앞부분을 뗀다), failed 403·500은 failed, 409는 다시 걸기', async () => {
    const un = doc({ id: 'd-un', noda_filename: 'U' });
    const lim = doc({ id: 'd-lim', noda_filename: 'L' });
    const srv = doc({ id: 'd-srv', noda_filename: 'S' });
    const dup = doc({ id: 'd-dup', noda_filename: 'D' });
    const { w, deps } = makeWorld([un, lim, srv, dup]);
    const at = new Date(w.clock.t - 1_000).toISOString();
    w.lists.set(nodaTenant(AGENT), {
      documents: [{ filename: 'U', readable: false, reason: `${DOC}__x.pdf PASSWORD_PROTECTED` }],
      receiving: [],
      failed: [
        { filename: 'L', status: 403, error: '한도', at },
        { filename: 'S', status: 500, error: '오류', at },
        { filename: 'D', status: 409, error: '같은 이름', at },
      ],
    });
    const out = await reconcileReading([un, lim, srv, dup], deps);
    expect(w.docs.get('d-un')).toMatchObject({ noda_status: 'unreadable', noda_reason: 'x.pdf PASSWORD_PROTECTED' });
    expect(w.docs.get('d-lim')).toMatchObject({ noda_status: 'failed', noda_reason: READ_LIMIT_REASON });
    expect(w.docs.get('d-srv')).toMatchObject({ noda_status: 'failed', noda_reason: READ_SERVER_FAILED_REASON });
    expect(w.docs.get('d-dup')!.noda_status).toBe('reading');
    expect(out.find((r) => r.id === 'd-dup')!.kick).toBe(true);
  });
});

describe('reconcileReading', () => {
  it('보관함마다 목록을 한 번만 부르고, ready·give_up을 행에 쓴다', async () => {
    const ready = doc({ id: 'd-ready', noda_filename: 'R' });
    const stuck = doc({ id: 'd-stuck', noda_filename: 'S', noda_read_started_at: iso(0) });
    const fresh = doc({ id: 'd-fresh', noda_filename: 'N', noda_read_started_at: iso(1_000_000 - 1000) });
    const { w, deps } = makeWorld([ready, stuck, fresh]);
    w.lists.set(nodaTenant(AGENT), listing(['R']));
    const rows = [...w.docs.values()];
    const out = await reconcileReading(rows, deps);
    expect(w.listCalls).toEqual([nodaTenant(AGENT)]);
    const byId = Object.fromEntries(out.map((r) => [r.id, r]));
    expect(byId['d-ready'].noda_status).toBe('ready');
    expect(w.docs.get('d-ready')!.noda_status).toBe('ready');
    expect(w.docs.get('d-ready')!.noda_read_at).toBe(iso(w.clock.t));
    expect(byId['d-stuck'].noda_status).toBe('failed');
    expect(w.docs.get('d-stuck')!.noda_status).toBe('failed');
    expect(w.docs.get('d-stuck')!.noda_reason).toBe(READ_TIMEOUT_REASON);
    expect(byId['d-fresh'].noda_status).toBe('reading');
    expect(byId['d-fresh'].kick).toBeUndefined();
  });

  it('reading이 아닌 행·비서 없는 행은 그대로 두고 목록도 안 부른다', async () => {
    const { w, deps } = makeWorld([
      doc({ id: 'a', noda_status: 'ready' }),
      doc({ id: 'b', agent_id: null }),
      doc({ id: 'c', noda_status: null }),
    ]);
    const rows = [...w.docs.values()];
    const out = await reconcileReading(rows, deps);
    expect(out).toEqual(rows);
    expect(w.listCalls).toHaveLength(0);
  });

  it('kick 대상이 여럿이면 가장 오래된 하나에만 kick', async () => {
    const t = 1_000_000;
    const a = doc({ id: 'a', noda_filename: 'A', noda_read_started_at: iso(t - 500_000) });
    const b = doc({ id: 'b', noda_filename: 'B', noda_read_started_at: iso(t - 300_000) });
    const c = doc({ id: 'c', agent_id: AGENT_B, noda_filename: 'C', noda_read_started_at: iso(t - 400_000) });
    const { w, deps } = makeWorld([a, b, c]);
    const out = await reconcileReading([...w.docs.values()], deps);
    const kicked = out.filter((r) => r.kick).map((r) => r.id);
    expect(kicked).toEqual(['a']);
    // kick은 DB를 바꾸지 않는다 — 화면이 읽기 라우트를 부르면 거기서 차지한다
    expect(w.docs.get('a')!.noda_last_attempt_at).toBeNull();
    expect(w.docs.get('a')!.noda_status).toBe('reading');
  });

  it('목록 호출이 실패하면 그 보관함 행은 그대로', async () => {
    const t = 1_000_000;
    const bad = doc({ id: 'bad', noda_filename: 'X', noda_read_started_at: iso(t - 700_000) });
    const ok = doc({ id: 'ok', agent_id: AGENT_B, noda_filename: 'Y' });
    const { w, deps } = makeWorld([bad, ok]);
    w.lists.set(nodaTenant(AGENT), new NodaError('NODA 503', 'http', 503));
    w.lists.set(nodaTenant(AGENT_B), listing(['Y']));
    const out = await reconcileReading([...w.docs.values()], deps);
    const byId = Object.fromEntries(out.map((r) => [r.id, r]));
    expect(byId['bad'].noda_status).toBe('reading'); // 10분 넘었어도 목록을 못 봤으니 포기하지 않는다
    expect(byId['bad'].kick).toBeUndefined();
    expect(w.docs.get('bad')!.noda_status).toBe('reading');
    expect(byId['ok'].noda_status).toBe('ready');
    expect(w.logs).toHaveLength(1);
  });

  it('한 번에 보관함 5개까지만 본다', async () => {
    const docs: StoredDocument[] = [];
    for (let i = 0; i < 7; i++) {
      const agent = `${i}1111111-2222-4333-8444-555555555555`;
      docs.push(doc({ id: `d${i}`, agent_id: agent, noda_filename: `F${i}`, noda_read_started_at: iso(1_000_000 - i * 1000) }));
    }
    const { w, deps } = makeWorld(docs);
    const out = await reconcileReading([...w.docs.values()], deps);
    expect(w.listCalls).toHaveLength(5);
    expect(new Set(w.listCalls).size).toBe(5);
    expect(out).toHaveLength(7);
  });

  it('목록은 다시 시도 없이 짧은 시간 제한으로 부른다(NODA 장애 중 화면이 멈추지 않게)', async () => {
    const { w, deps } = makeWorld([doc({ noda_filename: 'A' })]);
    await reconcileReading([...w.docs.values()], deps);
    expect(w.listOpts).toHaveLength(1);
    const opts = w.listOpts[0] as { retry: boolean; timeoutMs: number };
    expect(opts.retry).toBe(false);
    expect(opts.timeoutMs).toBeLessThanOrEqual(RECONCILE_LIST_TIMEOUT_MS);
    expect(RECONCILE_LIST_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });

  it('전체 예산을 넘기면 남은 보관함은 보지 않는다 — 그 행은 그대로', async () => {
    const docs: StoredDocument[] = [];
    for (let i = 0; i < 4; i++) {
      const agent = `${i}1111111-2222-4333-8444-555555555555`;
      docs.push(doc({ id: `d${i}`, agent_id: agent, noda_filename: `F${i}`, noda_read_started_at: iso(1_000_000 - 1000) }));
    }
    const { w, deps } = makeWorld(docs);
    w.listDelayMs = 3_000; // 느린 NODA
    const out = await reconcileReading([...w.docs.values()], deps);
    expect(RECONCILE_BUDGET_MS).toBeLessThanOrEqual(6_000);
    expect(w.listCalls.length).toBeLessThan(4);
    expect(w.listCalls.length).toBeGreaterThanOrEqual(1);
    // 남은 시간보다 긴 시간 제한을 주지 않는다
    for (const o of w.listOpts as { timeoutMs: number }[]) expect(o.timeoutMs).toBeLessThanOrEqual(RECONCILE_BUDGET_MS);
    expect(out).toHaveLength(4);
    expect(out.every((r) => r.noda_status === 'reading')).toBe(true);
  });

  it('처리한 보관함의 행은 한 줄로 이어 쓴다 — 같은 보관함 여러 행이 목록 한 번을 쓴다', async () => {
    const { w, deps } = makeWorld([
      doc({ id: 'a', noda_filename: 'A' }),
      doc({ id: 'b', noda_filename: 'B' }),
    ]);
    w.lists.set(nodaTenant(AGENT), listing(['A', 'B']));
    const out = await reconcileReading([...w.docs.values()], deps);
    expect(w.listCalls).toHaveLength(1);
    expect(out.map((r) => r.noda_status)).toEqual(['ready', 'ready']);
  });
});

describe('보관함을 deps가 정한다 (S5 일반화)', () => {
  const common = () => doc({ agent_id: undefined, org_type: '지방자치단체' });
  const commonTenant = (r: { org_type?: string | null }) => (r.org_type ? 'workon-c-local' : null);

  it('tenantOf가 보관함을 정한다 — 공통 문서 꼴의 행도 읽힌다', async () => {
    const { w, deps } = makeWorld([common()]);
    deps.tenantOf = commonTenant;
    await readDocument(DOC, {}, deps);
    expect(w.uploads[0].tenant).toBe('workon-c-local');
  });

  it('tenantOf가 null이면 not_found(보낼 보관함 없음)', async () => {
    const { w, deps } = makeWorld([doc()]);
    deps.tenantOf = () => null;
    expect(await readDocument(DOC, {}, deps)).toEqual({ status: 'not_found' });
    expect(w.uploads).toHaveLength(0);
  });

  it('맞추기도 tenantOf로 보관함을 묶는다 — 공통 문서 꼴, tenantOf가 null인 행은 건너뜀', async () => {
    const a = common();
    const skip = doc({ id: 'skip', agent_id: undefined, org_type: null, noda_filename: 'S' });
    const { w, deps } = makeWorld([a, skip]);
    deps.tenantOf = commonTenant;
    w.lists.set('workon-c-local', listing([a.noda_filename!]));
    const out = await reconcileReading([...w.docs.values()], deps);
    expect(w.listCalls).toEqual(['workon-c-local']);
    expect(out.find((r) => r.id === DOC)!.noda_status).toBe('ready');
    expect(out.find((r) => r.id === 'skip')!.noda_status).toBe('reading');
  });

  it('ready를 쓰면 afterReady를 한 번 부른다 — readDocument·reconcileReading 둘 다', async () => {
    const afterReady = vi.fn(async (_id: string) => {});
    const r2 = makeWorld();
    r2.deps.afterReady = afterReady;
    expect((await readDocument(DOC, {}, r2.deps)).status).toBe('ready');
    expect(afterReady).toHaveBeenCalledTimes(1);
    expect(afterReady).toHaveBeenCalledWith(DOC);

    afterReady.mockClear();
    const r3 = makeWorld([doc({ noda_filename: 'R' })]);
    r3.deps.afterReady = afterReady;
    r3.w.lists.set(nodaTenant(AGENT), listing(['R']));
    await reconcileReading([...r3.w.docs.values()], r3.deps);
    expect(afterReady).toHaveBeenCalledTimes(1);
    expect(afterReady).toHaveBeenCalledWith(DOC);
  });

  it('afterReady가 던져도 결과는 ready이고 warning만 남긴다', async () => {
    const r = makeWorld();
    r.deps.afterReady = async () => {
      throw new Error('boom');
    };
    expect((await readDocument(DOC, {}, r.deps)).status).toBe('ready');
    expect(r.w.docs.get(DOC)!.noda_status).toBe('ready');
    const warn = r.w.logs.find((l) => l.level === 'warning' && l.category === 'api');
    expect(warn).toBeDefined();
    expect(warn!.details).toMatchObject({ document_id: DOC });
    expect(JSON.stringify(warn!.details)).toContain('boom');

    const r2 = makeWorld([doc({ noda_filename: 'R' })]);
    r2.deps.afterReady = async () => {
      throw new Error('boom2');
    };
    r2.w.lists.set(nodaTenant(AGENT), listing(['R']));
    const out = await reconcileReading([...r2.w.docs.values()], r2.deps);
    expect(out[0].noda_status).toBe('ready');
    expect(r2.w.logs.some((l) => l.level === 'warning')).toBe(true);
  });

  it('afterReady는 unreadable·failed·쓰기 실패 때 부르지 않는다', async () => {
    const afterReady = vi.fn(async () => {});
    // unreadable
    const a = makeWorld();
    a.deps.afterReady = afterReady;
    a.w.upload = async () => ({ tenant: '', filename: '', bytes: 3, stored: true, doc_id: null, readable: false, reason: 'x', chunks: 0 });
    await readDocument(DOC, {}, a.deps);
    expect(a.w.docs.get(DOC)!.noda_status).toBe('unreadable');
    // failed (원본 없음)
    const b = makeWorld();
    b.deps.afterReady = afterReady;
    b.w.files.clear();
    await readDocument(DOC, {}, b.deps);
    expect(b.w.docs.get(DOC)!.noda_status).toBe('failed');
    // 쓰기 실패 — 업로드 중 다른 경로가 먼저 끝냄
    const c = makeWorld();
    c.deps.afterReady = afterReady;
    c.w.upload = async () => {
      c.w.docs.get(DOC)!.noda_status = 'failed';
      return { tenant: '', filename: '', bytes: 3, stored: true, doc_id: 'n-1', readable: true, reason: null, chunks: 4 };
    };
    await readDocument(DOC, {}, c.deps);
    // 맞추기: unreadable·failed
    const d = makeWorld([doc({ id: 'u', noda_filename: 'U' }), doc({ id: 's', noda_filename: 'S', noda_read_started_at: iso(0) })]);
    d.deps.afterReady = afterReady;
    d.w.lists.set(nodaTenant(AGENT), {
      documents: [{ filename: 'U', readable: false, reason: 'x' }],
      receiving: [],
      failed: [],
    });
    await reconcileReading([...d.w.docs.values()], d.deps);
    expect(d.w.docs.get('u')!.noda_status).toBe('unreadable');
    expect(d.w.docs.get('s')!.noda_status).toBe('failed');
    expect(afterReady).not.toHaveBeenCalled();
  });
});

describe('기본 의존성의 조건부 갱신', () => {
  it('차지는 reading이고 마지막 시도가 없거나 오래된 행에만 건다', async () => {
    vi.resetModules();
    const calls: [string, ...unknown[]][] = [];
    const chain: Record<string, unknown> = {};
    for (const m of ['update', 'eq', 'or', 'select']) {
      chain[m] = (...args: unknown[]) => {
        calls.push([m, ...args]);
        return m === 'select' ? Promise.resolve({ data: [{ id: DOC }], error: null }) : chain;
      };
    }
    vi.doMock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: { from: () => chain } }));
    const mod = await import('@/lib/document-reading');
    const ok = await mod.defaultReadingDeps().store.claim(DOC, iso(500_000), iso(380_000));
    expect(ok).toBe(true);
    expect(calls).toContainEqual(['update', { noda_last_attempt_at: iso(500_000) }]);
    expect(calls).toContainEqual(['eq', 'id', DOC]);
    expect(calls).toContainEqual(['eq', 'noda_status', 'reading']);
    expect(calls).toContainEqual(['or', `noda_last_attempt_at.is.null,noda_last_attempt_at.lt.${iso(380_000)}`]);
    vi.doUnmock('@/lib/supabaseAdmin');
  });
});
