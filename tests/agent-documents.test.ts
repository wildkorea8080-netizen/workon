import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { removeAgentDocuments, type AgentDocumentRow, type AgentDocumentsDeps } from '@/lib/agent-documents';
import { NodaError, nodaTenant } from '@/lib/noda';

/**
 * 비서를 지울 때 참고 문서 치우기 — 순서는 NODA 보관함 → DB 행 → 저장소 원본.
 * NODA를 못 비우면 NODA에 간 적 있는 행을 지우지 않는다(행을 먼저 지우면 사본을 찾을 길이 없다).
 */

const AGENT = '11111111-2222-4333-8444-555555555555';

function world(rows: AgentDocumentRow[] | null, nodaImpl?: () => Promise<{ existed: boolean; deleted: number | null }>) {
  const order: string[] = [];
  const deleted: string[] = [];
  const marked: string[] = [];
  const files: string[] = [];
  const tenants: string[] = [];
  const log = vi.fn(async () => {});
  const deps: AgentDocumentsDeps = {
    store: {
      async listRows() { order.push('list'); return rows; },
      async deleteRows(ids) { order.push('delete'); deleted.push(...ids); return true; },
      async markDeleting(ids) { order.push('mark'); marked.push(...ids); return true; },
      async removeFileIfUnused(path) { order.push('file'); files.push(path); },
    },
    noda: {
      async deleteTenant(tenant) {
        order.push('noda');
        tenants.push(tenant);
        return nodaImpl ? nodaImpl() : { existed: true, deleted: 2 };
      },
    },
    log,
  };
  return { deps, order, deleted, marked, files, tenants, log };
}

const rows: AgentDocumentRow[] = [
  { id: 'd1', storage_path: 'documents/a.pdf', noda_status: 'ready' },
  { id: 'd2', storage_path: 'documents/a.pdf', noda_status: 'reading' },
  { id: 'd3', storage_path: 'documents/old.pdf', noda_status: null },
];

describe('removeAgentDocuments', () => {
  it('NODA 보관함 → DB 행 → 저장소 원본 순서로 지운다(보관함은 비서 id로만 만든 이름)', async () => {
    const w = world(rows);
    expect(await removeAgentDocuments(AGENT, w.deps)).toEqual({ removed: 3, kept: 0, nodaCleared: true });
    expect(w.tenants).toEqual([nodaTenant(AGENT)]);
    expect(w.order).toEqual(['list', 'noda', 'delete', 'file', 'file']);
    expect(w.deleted).toEqual(['d1', 'd2', 'd3']);
    expect(w.files).toEqual(['documents/a.pdf', 'documents/old.pdf']);
    expect(w.log).not.toHaveBeenCalled();
  });

  it('보관함이 원래 없어도(404) 지운 것으로 본다', async () => {
    const w = world(rows, async () => ({ existed: false, deleted: null }));
    expect((await removeAgentDocuments(AGENT, w.deps)).removed).toBe(3);
  });

  it('NODA를 못 비우면 NODA에 간 행은 deleting으로 남기고 옛 행만 지운다', async () => {
    const w = world(rows, async () => { throw new NodaError('down', 'http', 503); });
    expect(await removeAgentDocuments(AGENT, w.deps)).toEqual({ removed: 1, kept: 2, nodaCleared: false });
    expect(w.marked).toEqual(['d1', 'd2']);
    expect(w.deleted).toEqual(['d3']);
    expect(w.files).toEqual(['documents/old.pdf']);
    expect(w.order.indexOf('mark')).toBeLessThan(w.order.indexOf('delete'));
    expect(w.log).toHaveBeenCalledTimes(1);
    const entry = (w.log.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(entry).toMatchObject({ level: 'warning', category: 'api' });
    expect(entry.details).toMatchObject({ agent_id: AGENT, documents_kept: 2, code: 'http', status: 503 });
    // 운영 기록에 저장소 경로·파일 이름이 없다
    expect(JSON.stringify(w.log.mock.calls)).not.toContain('a.pdf');
  });

  it('키 문제(401·403)는 critical', async () => {
    const w = world(rows, async () => { throw new NodaError('no', 'http', 401); });
    await removeAgentDocuments(AGENT, w.deps);
    expect((w.log.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({ level: 'critical' });
  });

  it('던진 값이 비어도(throw undefined) NODA 실패로 본다', async () => {
    const w = world(rows, async () => { throw undefined; });
    expect((await removeAgentDocuments(AGENT, w.deps)).nodaCleared).toBe(false);
    expect(w.deleted).toEqual(['d3']);
  });

  it('NODA 키가 없고 NODA에 간 행도 없으면 조용히 옛 행을 지운다', async () => {
    const w = world([rows[2]], async () => { throw new NodaError('missing', 'missing_key'); });
    expect(await removeAgentDocuments(AGENT, w.deps)).toEqual({ removed: 1, kept: 0, nodaCleared: false });
    expect(w.log).not.toHaveBeenCalled();
  });

  it('문서가 없어도 보관함은 비운다 — 행 없는 고아 사본까지', async () => {
    const w = world([]);
    expect(await removeAgentDocuments(AGENT, w.deps)).toEqual({ removed: 0, kept: 0, nodaCleared: true });
    expect(w.order).toEqual(['list', 'noda']);
  });

  it('행을 못 읽어도 보관함은 비우고 행은 건드리지 않는다', async () => {
    const w = world(null);
    expect(await removeAgentDocuments(AGENT, w.deps)).toEqual({ removed: 0, kept: 0, nodaCleared: true });
    expect(w.order).toEqual(['list', 'noda']);
  });

  it('행 삭제가 실패하면 원본 파일을 지우지 않는다', async () => {
    const w = world(rows);
    w.deps.store.deleteRows = async () => false;
    expect((await removeAgentDocuments(AGENT, w.deps)).removed).toBe(0);
    expect(w.files).toEqual([]);
  });
});

describe('비서 지우기 연결', () => {
  it('softDeleteAgent가 removeAgentDocuments를 부르고 결과를 판 기록에 남긴다', () => {
    const src = readFileSync('src/lib/agent-store.ts', 'utf8');
    expect(src).toContain("from '@/lib/agent-documents'");
    expect(src).toContain('await removeAgentDocuments(agentId)');
    expect(src).toContain('documents_kept');
    expect(src).not.toContain("from('documents')");
  });
});
