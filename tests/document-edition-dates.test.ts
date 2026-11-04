import { readFileSync } from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isInForce, kstToday, notCitableEditionIds } from '@/lib/edition-dates';
import {
  DUE_LOOKBACK_DAYS, MAX_DUE_RETIREMENTS, pendingRetirements, retireDueEditions, retireReplacedDocument,
  type DueEditionDeps, type EditionDeps, type EditionRow,
} from '@/lib/document-editions';
import { createDocSearch, sourcesToChunks, type AgentDocument, type DocSearchDeps } from '@/lib/capabilities/doc-search';
import type { NodaContextResult, NodaSource } from '@/lib/noda';
import type { TurnContext } from '@/lib/capabilities/types';
import { editionNote } from '@/components/admin/DocumentsManager';
import type { Document } from '@/lib/db';

/**
 * 시행일 예약(2026-11-05) — 바꿀 옛 판을 고르고 시행일을 오늘 뒤로 적은 새 판은, 읽혀도 시행일 전까지 옛 판이 근거이고
 * 시행일(00:00 KST)부터 새 판이 근거다. 옛 판 내리기는 하루 한 번 예약 작업과 문서 목록이 한다.
 */

const AGENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OLD = '11111111-2222-4333-8444-555555555555';
const NEW = '66666666-7777-4888-8999-aaaaaaaaaaaa';

afterEach(() => vi.useRealTimers());

describe('시행일 규칙(edition-dates)', () => {
  it('오늘은 한국 시각으로 — KST 자정에 날짜가 바뀐다', () => {
    expect(kstToday(Date.parse('2026-11-04T14:59:59Z'))).toBe('2026-11-04');
    expect(kstToday(Date.parse('2026-11-04T15:00:00Z'))).toBe('2026-11-05');
  });
  it('시행일이 없거나 오늘·그 전이면 시행 중', () => {
    expect([isInForce(null, '2026-11-05'), isInForce(undefined, '2026-11-05'), isInForce('', '2026-11-05')]).toEqual([true, true, true]);
    expect(isInForce('2026-11-05', '2026-11-05')).toBe(true);
    expect(isInForce('2026-11-04', '2026-11-05')).toBe(true);
    expect(isInForce('2026-11-06', '2026-11-05')).toBe(false);
  });
  it('시행 중인 새 판은 옛 판을, 시행일 전인 새 판은 자기 자신을 근거에서 뺀다', () => {
    const base = { id: NEW, noda_status: 'ready', replaces_id: OLD };
    expect([...notCitableEditionIds([base], '2026-11-05')]).toEqual([OLD]);
    expect([...notCitableEditionIds([{ ...base, effective_from: '2026-11-05' }], '2026-11-05')]).toEqual([OLD]);
    expect([...notCitableEditionIds([{ ...base, effective_from: '2027-01-01' }], '2026-11-05')]).toEqual([NEW]);
    // 아직 읽는 새 판·바꿀 판이 없는(옛 판을 지운) 문서는 아무것도 빼지 않는다
    expect(notCitableEditionIds([{ ...base, noda_status: 'reading', effective_from: '2027-01-01' }], '2026-11-05').size).toBe(0);
    expect(notCitableEditionIds([{ ...base, replaces_id: null, effective_from: '2027-01-01' }], '2026-11-05').size).toBe(0);
  });
  it('잎 파일이다 — 화면(문서 화면)이 읽으므로 아무것도 import하지 않고, 화면은 서버 모듈을 가져오지 않는다', () => {
    expect(readFileSync('src/lib/edition-dates.ts', 'utf8')).not.toMatch(/^import /m);
    const ui = readFileSync('src/components/admin/DocumentsManager.tsx', 'utf8');
    expect(ui).toContain("from '@/lib/edition-dates'");
    expect(ui).not.toContain("from '@/lib/document-editions'");
  });
});

const doc = (over: Partial<AgentDocument>): AgentDocument => ({ id: OLD, title: '여비 규정', file_name: '여비.hwp', noda_status: 'ready', replaces_id: null, ...over });
const source = (n: number, docId: string, name: string): NodaSource => ({ n, chunk_id: `c${n}`, doc_id: 'd', filename: `${docId}__${name}`, similarity: 0.85 });

describe('문서 찾기 — 시행일 전에는 옛 판이 근거', () => {
  const sources = [source(1, OLD, '여비.hwp'), source(2, NEW, '여비(개정).hwp')];
  const docs = [doc({}), doc({ id: NEW, title: '여비 규정(개정)', replaces_id: OLD, effective_from: '2027-01-01' })];
  it('시행일 전날까지는 옛 판, 시행일부터는 새 판(근거 창에 시행일)', () => {
    const before = sourcesToChunks(sources, docs, new Map(), '2026-12-31');
    expect(before.chunks.map((c) => c.documentId)).toEqual([OLD]);
    expect(before.superseded).toBe(1);
    expect(before.chunks[0].effectiveFrom).toBeUndefined();
    const on = sourcesToChunks(sources, docs, new Map(), '2027-01-01');
    expect(on.chunks.map((c) => c.documentId)).toEqual([NEW]);
    expect(on.chunks[0].effectiveFrom).toBe('2027-01-01');
  });
  it('시행일 전 턴은 새 판 글을 프롬프트에 싣지 않는다(받아들인 블록만) — 실제 시각으로', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-12-31T14:00:00Z')); // KST 12-31 23:00
    const context: NodaContextResult = {
      context: `[1] ${OLD}__여비.hwp p.3\n일비 2만원(지금 규정)\n[2] ${NEW}__여비(개정).hwp p.3\n일비 2만5천원(개정, 시행 전)`,
      sources,
      dropped: 0,
    };
    const d: DocSearchDeps = {
      documentsOf: async () => docs,
      fetchContext: async () => context,
      findDocuments: async () => [],
      deleteOrphan: async () => {},
      orgTypeOf: async () => null,
      commonDocumentsOf: async () => [],
      fetchCommonContext: async () => ({ context: '', sources: [], dropped: 0 }),
      findCommonDocuments: async () => [],
      deleteCommonOrphan: async () => {},
      log: async () => {},
    };
    const cap = createDocSearch(d);
    const pre = await cap.preflight!({ organizationId: 'org', agentId: AGENT, message: '일비', skipDocuments: false });
    if (!pre.ok) throw new Error('거절됨');
    const ctx = { organizationId: 'org', departmentId: 'dept', userId: 'u', agentId: AGENT, agentVersion: 1, conversationId: 'c', attachments: [], capabilities: { doc_search: {} }, message: '일비', preflight: { doc_search: pre.carry }, skipDocuments: false } as TurnContext;
    const out = await cap.prepare!(ctx);
    expect(out.chunks?.map((c) => c.documentId)).toEqual([OLD]);
    expect(out.systemAddendum).toContain('일비 2만원(지금 규정)');
    expect(out.systemAddendum).not.toContain('시행 전');

    vi.setSystemTime(new Date('2026-12-31T15:00:00Z')); // KST 2027-01-01 00:00
    const pre2 = await cap.preflight!({ organizationId: 'org', agentId: AGENT, message: '일비', skipDocuments: false });
    if (!pre2.ok) throw new Error('거절됨');
    const out2 = await cap.prepare!({ ...ctx, preflight: { doc_search: pre2.carry } } as TurnContext);
    expect(out2.chunks?.map((c) => c.documentId)).toEqual([NEW]);
    expect(out2.systemAddendum).not.toContain('지금 규정');
  });
});

const row = (over: Partial<EditionRow>): EditionRow => ({ id: NEW, agent_id: AGENT, noda_status: 'ready', noda_filename: `${NEW}__여비(개정).hwp`, replaces_id: OLD, retired_at: null, ...over });

function editionDeps(rows: Record<string, EditionRow>, nowIso: string) {
  const retired: string[] = [];
  const deleteDocument = vi.fn(async () => ({ deleted: true }));
  const deps: EditionDeps = {
    store: {
      getRow: async (id) => rows[id] ?? null,
      retire: async (id) => { retired.push(id); return true; },
      markDeleting: async () => true,
    },
    noda: { deleteDocument: deleteDocument as unknown as EditionDeps['noda']['deleteDocument'] },
    now: () => Date.parse(nowIso),
    log: async () => {},
  };
  return { deps, retired, deleteDocument };
}

describe('판 바꾸기 — 시행일 예약', () => {
  const rows = { [NEW]: row({ effective_from: '2027-01-01' }), [OLD]: row({ id: OLD, replaces_id: null, noda_filename: `${OLD}__여비.hwp` }) };
  it('새 판이 읽혀도 시행일 전이면 옛 판을 건드리지 않고 scheduled', async () => {
    const t = editionDeps(rows, '2026-12-31T14:59:59Z');
    expect(await retireReplacedDocument(NEW, t.deps)).toBe('scheduled');
    expect(t.deleteDocument).not.toHaveBeenCalled();
    expect(t.retired).toEqual([]);
  });
  it('시행일(KST)이 되면 옛 판을 내린다', async () => {
    const t = editionDeps(rows, '2026-12-31T15:00:00Z');
    expect(await retireReplacedDocument(NEW, t.deps)).toBe('retired');
    expect(t.retired).toEqual([OLD]);
  });
  it('문서 목록의 다시 걸기는 시행일이 된 새 판만', () => {
    const list = [row({ effective_from: '2027-01-01' }), row({ id: OLD, replaces_id: null })];
    expect(pendingRetirements(list, '2026-12-31')).toEqual([]);
    expect(pendingRetirements(list, '2027-01-01')).toEqual([NEW]);
  });
});

function dueDeps(opts: { due: Array<{ id: string; replaces_id: string }>; current: string[]; fail?: string; retireResult?: Record<string, string> }) {
  const calls: Array<{ since: string; today: string }> = [];
  const retiredCalls: string[] = [];
  const logs: unknown[] = [];
  const deps: DueEditionDeps = {
    listDue: async (since, today) => { calls.push({ since, today }); if (opts.fail === 'list') throw new Error('boom'); return opts.due; },
    currentIds: async (ids) => ids.filter((id) => opts.current.includes(id)),
    retire: async (id) => {
      retiredCalls.push(id);
      if (opts.fail === id) throw new Error('db');
      return (opts.retireResult?.[id] ?? 'retired') as Awaited<ReturnType<DueEditionDeps['retire']>>;
    },
    now: () => Date.parse('2027-01-01T00:00:00Z'), // KST 2027-01-01 09:00
    log: async (e) => { logs.push(e); },
  };
  return { deps, calls, retiredCalls, logs };
}

describe('하루 한 번 — 시행일이 된 새 판의 옛 판 내리기(retireDueEditions)', () => {
  it('오늘(KST)까지 시행일이 된 새 판 중 옛 판이 아직 현재 판인 것만 내린다', async () => {
    const t = dueDeps({ due: [{ id: 'n1', replaces_id: 'o1' }, { id: 'n2', replaces_id: 'o2' }, { id: 'n3', replaces_id: 'o3' }], current: ['o1', 'o3'], retireResult: { n3: 'kept_deleting' } });
    expect(await retireDueEditions(t.deps)).toEqual({ due: 2, retired: 1, failed: 1 });
    expect(t.retiredCalls).toEqual(['n1', 'n3']);
    expect(t.calls).toEqual([{ since: '2026-12-02', today: '2027-01-01' }]);
    expect(DUE_LOOKBACK_DAYS).toBe(30);
  });
  it(`한 번에 ${MAX_DUE_RETIREMENTS}개까지, 하나가 던져도 나머지를 잇고 운영 기록(파일 이름 없음)`, async () => {
    const due = Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, replaces_id: `o${i}` }));
    const t = dueDeps({ due, current: due.map((d) => d.replaces_id), fail: 'n3' });
    expect(await retireDueEditions(t.deps)).toEqual({ due: 50, retired: 49, failed: 1 });
    expect(t.logs).toEqual([expect.objectContaining({ level: 'warning', details: expect.objectContaining({ document_id: 'n3' }) })]);
  });
  it('조회가 실패하면 던지지 않고 기록만', async () => {
    const t = dueDeps({ due: [], current: [], fail: 'list' });
    expect(await retireDueEditions(t.deps)).toEqual({ due: 0, retired: 0, failed: 0 });
    expect(t.logs).toHaveLength(1);
  });
  it('하루 한 번 예약 작업(/api/cron/noda-events)이 부르고, 조회는 1,000행 안에서', () => {
    const route = readFileSync('src/app/api/cron/noda-events/route.ts', 'utf8');
    expect(route).toContain('const editions = await retireDueEditions();');
    const lib = readFileSync('src/lib/document-editions.ts', 'utf8');
    expect(lib).toContain(".gte('effective_from', since)");
    expect(lib).toContain(".lte('effective_from', today)");
  });
});

describe('화면·근거 표시', () => {
  const d = (over: Partial<Document>): Document => ({ id: OLD, department_id: 'd', agent_id: AGENT, storage_path: 'p', file_name: '여비.hwp', title: '여비 규정', metadata: {}, created_at: '', updated_at: '', noda_status: 'ready', noda_reason: null, noda_filename: null, noda_doc_id: null, noda_read_started_at: null, noda_last_attempt_at: null, noda_read_at: null, ...over });
  it('시행일 전인 새 판 줄은 그날까지 옛 판을 쓴다고 알린다', () => {
    const docs = [d({})];
    expect(editionNote(d({ id: NEW, replaces_id: OLD, effective_from: '2027-01-01' }), docs, '2026-12-31')).toContain('시행일(2027-01-01)까지는 옛 판을 근거로');
    expect(editionNote(d({ id: NEW, replaces_id: OLD, effective_from: '2027-01-01', noda_status: 'reading' }), docs, '2026-12-31')).toContain('시행일(2027-01-01)에 옛 판을');
    expect(editionNote(d({ id: NEW, replaces_id: OLD, effective_from: '2027-01-01' }), docs, '2027-01-01')).toContain('내리는 중');
  });
  it('근거 조각의 시행일은 저장되고 근거 창에 보이며, 업무 규정 확인도 적용 판정에 쓴다', () => {
    expect(readFileSync('src/lib/assistant/persist.ts', 'utf8')).toContain('effectiveFrom: c.effectiveFrom,');
    expect(readFileSync('src/components/chat/SourcePanel.tsx', 'utf8')).toContain('시행 {source.effectiveFrom}');
    const providers = readFileSync('src/lib/work/workflows/regulations/providers.ts', 'utf8');
    expect(providers).toContain("effectiveDate: kind === 'org_doc' ? c.effectiveFrom ?? null : null,");
    // 업무 규정 확인도 판(0055) 규칙을 따르려면 replaces_id·effective_from을 읽어야 한다(전에는 빠져 옛 판도 근거였다)
    expect(providers).toContain('noda_status, replaces_id, effective_from, agent_id');
  });
});
