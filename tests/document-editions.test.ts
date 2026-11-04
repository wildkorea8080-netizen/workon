import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import {
  parseEffectiveFrom, pendingRetirements, replaceTargetError, retireReplacedDocument,
  type EditionDeps, type EditionRow,
} from '@/lib/document-editions';
import { createDocSearch, sourcesToChunks, type AgentDocument, type DocSearchDeps } from '@/lib/capabilities/doc-search';
import { NodaError, nodaTenant, type NodaContextResult, type NodaSource } from '@/lib/noda';
import type { TurnContext } from '@/lib/capabilities/types';
import { editionNote, replaceCandidates } from '@/components/admin/DocumentsManager';
import type { Document } from '@/lib/db';

/** 비서 문서의 판(개정본) 관리(0055) — 새 판이 읽히면 옛 판을 내리고, 그 사이에도 옛 판은 근거가 아니다 */

const AGENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OLD = '11111111-2222-4333-8444-555555555555';
const NEW = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const row = (over: Partial<EditionRow>): EditionRow => ({ id: NEW, agent_id: AGENT, noda_status: 'ready', noda_filename: `${NEW}__여비(개정).hwp`, replaces_id: OLD, retired_at: null, ...over });

function editionDeps(rows: Record<string, EditionRow>, nodaDelete: () => Promise<unknown> = async () => ({ deleted: true })) {
  const retired: string[] = [];
  const deleting: string[] = [];
  const logs: unknown[] = [];
  const deleteDocument = vi.fn(nodaDelete);
  const deps: EditionDeps = {
    store: {
      getRow: async (id) => rows[id] ?? null,
      retire: async (id) => { retired.push(id); return true; },
      markDeleting: async (id) => { deleting.push(id); return true; },
    },
    noda: { deleteDocument: deleteDocument as unknown as EditionDeps['noda']['deleteDocument'] },
    now: () => Date.parse('2026-11-04T00:00:00Z'),
    log: async (e) => { logs.push(e); },
  };
  return { deps, retired, deleting, logs, deleteDocument };
}

describe('판 바꾸기(retireReplacedDocument)', () => {
  it('새 판이 ready면 옛 판의 NODA 사본을 그 비서 보관함에서 지우고 지난 판으로', async () => {
    const t = editionDeps({ [NEW]: row({}), [OLD]: row({ id: OLD, replaces_id: null, noda_filename: `${OLD}__여비.hwp` }) });
    expect(await retireReplacedDocument(NEW, t.deps)).toBe('retired');
    expect(t.deleteDocument).toHaveBeenCalledWith(nodaTenant(AGENT), `${OLD}__여비.hwp`);
    expect(t.retired).toEqual([OLD]);
    expect(JSON.stringify(t.logs)).not.toContain('여비');
  });
  it('새 판이 읽는 중·실패, 바꿀 판이 없음, 다른 비서, 이미 지난 판·지우는 중이면 건드리지 않는다', async () => {
    for (const [fresh, old] of [
      [row({ noda_status: 'reading' }), row({ id: OLD })],
      [row({ noda_status: 'failed' }), row({ id: OLD })],
      [row({ replaces_id: null }), row({ id: OLD })],
      [row({}), row({ id: OLD, agent_id: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee' })],
      [row({}), row({ id: OLD, noda_status: 'retired', retired_at: '2026-11-01T00:00:00Z' })],
      [row({}), row({ id: OLD, noda_status: 'deleting' })],
    ] as const) {
      const t = editionDeps({ [NEW]: fresh, [OLD]: old });
      expect(await retireReplacedDocument(NEW, t.deps)).toBe('none');
      expect(t.deleteDocument).not.toHaveBeenCalled();
      expect(t.retired).toEqual([]);
    }
  });
  it('NODA를 못 지우면 옛 판을 deleting으로 두고 경고, 옛 행(NULL)은 NODA를 건너뛰고 내린다', async () => {
    const fail = editionDeps({ [NEW]: row({}), [OLD]: row({ id: OLD }) }, async () => { throw new NodaError('HTTP 503', 'http', 503); });
    expect(await retireReplacedDocument(NEW, fail.deps)).toBe('kept_deleting');
    expect(fail.deleting).toEqual([OLD]);
    expect(fail.retired).toEqual([]);
    expect(fail.logs).toEqual([expect.objectContaining({ level: 'warning', details: expect.objectContaining({ document_id: OLD, replaced_by: NEW, status: 503 }) })]);
    const legacy = editionDeps({ [NEW]: row({}), [OLD]: row({ id: OLD, noda_status: null, noda_filename: null }) });
    expect(await retireReplacedDocument(NEW, legacy.deps)).toBe('retired');
    expect(legacy.deleteDocument).not.toHaveBeenCalled();
  });
  it('목록에서 판 바꾸기가 남은 새 판만 고른다', () => {
    const list = [
      row({}), row({ id: OLD, replaces_id: null }),
      row({ id: 'n2', replaces_id: 'o2' }), row({ id: 'o2', replaces_id: null, noda_status: 'retired', retired_at: 'x' }),
      row({ id: 'n3', replaces_id: 'o3', noda_status: 'reading' }), row({ id: 'o3', replaces_id: null }),
      row({ id: 'n4', replaces_id: 'gone' }),
    ];
    expect(pendingRetirements(list)).toEqual([NEW]);
  });
});

describe('올릴 때 검사', () => {
  it('시행일은 실제 날짜만, 비우면 없음', () => {
    expect([parseEffectiveFrom(undefined), parseEffectiveFrom(''), parseEffectiveFrom('2026-03-01')]).toEqual([null, null, '2026-03-01']);
    for (const bad of ['2026-02-30', '26-03-01', '1999-12-31', 20260301]) expect(parseEffectiveFrom(bad)).toBeUndefined();
  });
  it('바꿀 옛 판은 비서 하나·같은 비서·현재 판·겹치는 새 판 없음', () => {
    const target = { id: OLD, agent_id: AGENT, noda_status: 'ready', retired_at: null };
    expect(replaceTargetError({ agentIds: [AGENT], target, competing: 0 })).toBeNull();
    expect(replaceTargetError({ agentIds: [AGENT, 'x'], target, competing: 0 })).toContain('비서 하나');
    expect(replaceTargetError({ agentIds: [AGENT], target: null, competing: 0 })).toContain('찾을 수 없습니다');
    expect(replaceTargetError({ agentIds: [AGENT], target: { ...target, agent_id: 'x' }, competing: 0 })).toContain('찾을 수 없습니다');
    expect(replaceTargetError({ agentIds: [AGENT], target: { ...target, noda_status: 'retired', retired_at: 'x' }, competing: 0 })).toContain('지난 판');
    expect(replaceTargetError({ agentIds: [AGENT], target: { ...target, noda_status: 'deleting' }, competing: 0 })).toContain('지우는 중');
    expect(replaceTargetError({ agentIds: [AGENT], target, competing: 1 })).toContain('이미 올라가');
  });
});

const doc = (over: Partial<AgentDocument>): AgentDocument => ({ id: OLD, title: '여비 규정', file_name: '여비.hwp', noda_status: 'ready', replaces_id: null, ...over });
const source = (n: number, docId: string, name: string): NodaSource => ({ n, chunk_id: `c${n}`, doc_id: 'd', filename: `${docId}__${name}`, similarity: 0.85 });

describe('문서 찾기 — 대신된 옛 판은 근거가 아니다', () => {
  it('ready 새 판이 가리키는 옛 판(ready·deleting)의 조각은 빼고 센다 — 새 판이 아직 읽는 중이면 옛 판이 근거', () => {
    const sources = [source(1, OLD, '여비.hwp'), source(2, NEW, '여비(개정).hwp')];
    for (const oldStatus of ['ready', 'deleting'] as const) {
      const m = sourcesToChunks(sources, [doc({ noda_status: oldStatus }), doc({ id: NEW, title: '여비 규정(개정)', replaces_id: OLD })]);
      expect(m.chunks.map((c) => c.documentId)).toEqual([NEW]);
      expect(m.superseded).toBe(1);
    }
    const reading = sourcesToChunks([source(1, OLD, '여비.hwp')], [doc({}), doc({ id: NEW, replaces_id: OLD, noda_status: 'reading' })]);
    expect(reading.chunks.map((c) => c.documentId)).toEqual([OLD]);
    expect(reading.superseded).toBe(0);
  });
  it('대신된 조각이 있었던 턴은 옛 판 글을 프롬프트에 싣지 않는다(받아들인 블록만)', async () => {
    const context: NodaContextResult = {
      context: `[1] ${OLD}__여비.hwp p.3\n일비 2만원(옛 규정)\n[2] ${NEW}__여비(개정).hwp p.3\n일비 2만5천원(개정)`,
      sources: [source(1, OLD, '여비.hwp'), source(2, NEW, '여비(개정).hwp')],
      dropped: 0,
    };
    const d: DocSearchDeps = {
      documentsOf: async () => [doc({}), doc({ id: NEW, title: '여비 규정(개정)', replaces_id: OLD })],
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
    expect(out.chunks?.map((c) => c.documentId)).toEqual([NEW]);
    expect(out.systemAddendum).toContain('일비 2만5천원(개정)');
    expect(out.systemAddendum).not.toContain('옛 규정');
  });
});

describe('화면·연결(원본 확인)', () => {
  const d = (over: Partial<Document>): Document => ({ id: OLD, department_id: 'd', agent_id: AGENT, storage_path: 'p', file_name: '여비.hwp', title: '여비 규정', metadata: {}, created_at: '', updated_at: '', noda_status: 'ready', noda_reason: null, noda_filename: null, noda_doc_id: null, noda_read_started_at: null, noda_last_attempt_at: null, noda_read_at: null, ...over });
  it('후보는 고른 비서 하나의 현재 판만, 새 판 줄 안내는 상태에 따라', () => {
    const docs = [d({}), d({ id: 'x', noda_status: 'retired', retired_at: 'x' }), d({ id: 'y', noda_status: 'deleting' }), d({ id: 'z', agent_id: 'other' })];
    expect(replaceCandidates(docs, [AGENT]).map((x) => x.id)).toEqual([OLD]);
    expect(replaceCandidates(docs, [AGENT, 'other'])).toEqual([]);
    expect(editionNote(d({ id: NEW, replaces_id: OLD, noda_status: 'reading' }), docs)).toContain('다 읽히면');
    expect(editionNote(d({ id: NEW, replaces_id: OLD }), docs)).toContain('내리는 중');
    expect(editionNote(d({ id: NEW, replaces_id: 'x' }), docs)).toContain('옛 판은 지난 판');
  });
  it('읽기 의존이 판 바꾸기를 걸고, 목록은 남은 판 바꾸기를 다시 걸며, 지난 판은 NODA 삭제·다른 비서 붙이기를 건너뛴다', () => {
    expect(readFileSync('src/lib/document-reading.ts', 'utf8')).toMatch(/afterReady: async \(id\) => \{\s*await retireReplacedDocument\(id\);/);
    const list = readFileSync('src/app/api/documents/route.ts', 'utf8');
    expect(list).toContain('pendingRetirements(rows');
    expect(list).toContain("doc.noda_status !== 'retired'");
    expect(readFileSync('src/app/api/documents/assign/route.ts', 'utf8')).toContain("src.noda_status === 'retired'");
    const confirm = readFileSync('src/app/api/documents/confirm/route.ts', 'utf8');
    expect(confirm).toContain('replaceTargetError(');
    expect(confirm).toContain('replaces_id: replacesId, effective_from: effectiveFrom');
    expect(readFileSync('src/lib/capabilities/doc-search.ts', 'utf8')).toContain(".select('id, title, file_name, noda_status, replaces_id')");
  });
  it('문서 화면은 지난 판을 칩으로 보이고 시행일·대신하는 판을 적는다', () => {
    const ui = readFileSync('src/components/admin/DocumentsManager.tsx', 'utf8');
    expect(ui).toMatch(/case 'retired':\s*return <span[^>]*>지난 판 — 근거로 쓰지 않음<\/span>;/);
    expect(ui).toContain('{doc.effective_from && <span className="text-xs text-slate-500">시행 {doc.effective_from}</span>}');
    expect(ui).toContain('{doc.replaces_id && <p className="mt-1 text-xs text-slate-500">{editionNote(doc, documents)}</p>}');
  });
  it('마이그레이션 — 칸 셋·상태 값 retired·자기 자신 금지·지난 판 짝', () => {
    const sql = readFileSync('supabase/migrations/0055_document_editions.sql', 'utf8');
    for (const c of ['ADD COLUMN IF NOT EXISTS replaces_id uuid REFERENCES public.documents(id) ON DELETE SET NULL', 'ADD COLUMN IF NOT EXISTS retired_at timestamptz', 'ADD COLUMN IF NOT EXISTS effective_from date', "'deleting', 'retired'", 'replaces_id <> id', "(noda_status IS NOT DISTINCT FROM 'retired') = (retired_at IS NOT NULL)"]) {
      expect(sql).toContain(c);
    }
  });
});
