import { describe, expect, it, vi } from 'vitest';
import {
  commonReadingDeps,
  deleteCommonDocument,
  retireReplacedEdition,
  type CommonStore,
} from '@/lib/common-documents';
import { NodaError } from '@/lib/noda';
import type { CommonDocument } from '@/lib/db';

/**
 * 공통 문서(S5) — 새 판이 ready가 되면 옛 판을 내리고(NODA 사본 삭제 → retired), 지울 때는 NODA → 행 → 원본 순서.
 * 새 판이 읽히는 동안(reading·failed)은 옛 판이 계속 현재 판이다 — 그 사이 근거가 비면 안 된다.
 */

const NEW_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const OLD_ID = 'aaaaaaaa-0000-4000-8000-000000000002';
const NOW = Date.parse('2026-10-25T09:00:00Z');

function row(over: Partial<CommonDocument> = {}): CommonDocument {
  return {
    id: NEW_ID, org_type: '지방자치단체', title: '여비 규정', edition_year: 2026, usage_terms: '공공누리 1유형',
    file_name: '여비.pdf', file_type: 'pdf', size_bytes: 10, storage_path: 'common/local/new.pdf',
    noda_status: 'ready', noda_reason: null, noda_filename: `${NEW_ID}__여비 규정(2026).pdf`, noda_doc_id: 'sha256:n',
    noda_read_started_at: null, noda_last_attempt_at: null, noda_read_at: null,
    replaces_id: OLD_ID, retired_at: null, uploaded_by: null,
    created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(), ...over,
  };
}
const oldRow = (over: Partial<CommonDocument> = {}) =>
  row({ id: OLD_ID, noda_filename: `${OLD_ID}__여비 규정(2025).pdf`, edition_year: 2025, replaces_id: null, storage_path: 'common/local/old.pdf', ...over });

function world(rows: CommonDocument[], opts: { nodaFails?: unknown; nodaDeleted?: boolean } = {}) {
  const docs = new Map(rows.map((r) => [r.id, r]));
  const calls: string[] = [];
  const nodaDeletes: { tenant: string; filename: string }[] = [];
  const removed: string[] = [];
  const log = vi.fn(async (_p: unknown) => {});
  const store: CommonStore = {
    async getRow(id) { const d = docs.get(id); return d ? { ...d } : null; },
    async retire(id, nowIso) {
      calls.push(`retire:${id}`);
      const d = docs.get(id);
      if (!d || d.retired_at || d.noda_status === 'deleting') return false;
      d.noda_status = 'retired'; d.retired_at = nowIso;
      return true;
    },
    async markDeleting(id) { calls.push(`markDeleting:${id}`); const d = docs.get(id); if (!d) return false; d.noda_status = 'deleting'; return true; },
    async deleteRow(id) { calls.push(`deleteRow:${id}`); return docs.delete(id); },
    async removeFile(path) { calls.push(`removeFile:${path}`); removed.push(path); },
  };
  const noda = {
    async deleteDocument(tenant: string, filename: string) {
      calls.push(`noda:${filename}`);
      nodaDeletes.push({ tenant, filename });
      if (opts.nodaFails) throw opts.nodaFails;
      return { deleted: opts.nodaDeleted ?? true };
    },
  };
  return { docs, calls, nodaDeletes, removed, log, deps: { store, noda, now: () => NOW, log } };
}

describe('retireReplacedEdition', () => {
  it('새 판이 ready가 되면 옛 판 NODA 사본을 지우고 retired', async () => {
    const w = world([row(), oldRow({ noda_status: 'ready' })]);
    expect(await retireReplacedEdition(NEW_ID, w.deps)).toBe('retired');
    expect(w.nodaDeletes).toEqual([{ tenant: 'workon-c-local', filename: `${OLD_ID}__여비 규정(2025).pdf` }]);
    expect(w.calls).toEqual([`noda:${oldRow().noda_filename}`, `retire:${OLD_ID}`]);
    expect(w.docs.get(OLD_ID)).toMatchObject({ noda_status: 'retired', retired_at: new Date(NOW).toISOString() });
    expect(w.log).toHaveBeenCalledWith(expect.objectContaining({
      level: 'info', message: '공통 문서 지난 판으로 바꿈', details: { document_id: OLD_ID, replaced_by: NEW_ID },
    }));
  });

  it('새 판이 ready가 아니면(읽는 중·실패) 옛 판을 건드리지 않는다', async () => {
    for (const status of ['reading', 'failed', 'unreadable', 'deleting', 'retired'] as const) {
      const w = world([row({ noda_status: status }), oldRow()]);
      expect(await retireReplacedEdition(NEW_ID, w.deps)).toBe('none');
      expect(w.calls).toEqual([]);
      expect(w.docs.get(OLD_ID)!.retired_at).toBeNull();
    }
  });

  it('새 판에 replaces_id가 없거나 새 판 행이 없으면 none', async () => {
    const a = world([row({ replaces_id: null }), oldRow()]);
    expect(await retireReplacedEdition(NEW_ID, a.deps)).toBe('none');
    expect(a.calls).toEqual([]);
    const b = world([oldRow()]);
    expect(await retireReplacedEdition(NEW_ID, b.deps)).toBe('none');
  });

  it('옛 판 NODA 삭제가 실패하면 deleting으로 두고 kept_deleting, warning에 파일 이름 없음', async () => {
    const w = world([row(), oldRow()], { nodaFails: new NodaError('boom', 'http', 503) });
    expect(await retireReplacedEdition(NEW_ID, w.deps)).toBe('kept_deleting');
    expect(w.calls).toEqual([`noda:${oldRow().noda_filename}`, `markDeleting:${OLD_ID}`]);
    expect(w.docs.get(OLD_ID)).toMatchObject({ noda_status: 'deleting', retired_at: null });
    const entry = w.log.mock.calls[0][0] as { level: string; details: Record<string, unknown> };
    expect(entry.level).toBe('warning');
    expect(entry.details).toEqual({ document_id: OLD_ID, code: 'http', status: 503, request_id: null });
    expect(JSON.stringify(w.log.mock.calls)).not.toContain('여비');
  });

  it('옛 판이 다른 유형·이미 지난 판·없음·deleting이면 none', async () => {
    const other = world([row(), oldRow({ org_type: '공공기관' })]);
    expect(await retireReplacedEdition(NEW_ID, other.deps)).toBe('none');
    expect(other.calls).toEqual([]);
    const gone = world([row(), oldRow({ noda_status: 'retired', retired_at: '2026-01-01T00:00:00Z' })]);
    expect(await retireReplacedEdition(NEW_ID, gone.deps)).toBe('none');
    expect(gone.calls).toEqual([]);
    const missing = world([row()]);
    expect(await retireReplacedEdition(NEW_ID, missing.deps)).toBe('none');
    const deleting = world([row(), oldRow({ noda_status: 'deleting' })]);
    expect(await retireReplacedEdition(NEW_ID, deleting.deps)).toBe('none');
  });

  it('NODA 404(deleted:false)는 지운 것으로 센다', async () => {
    const w = world([row(), oldRow()], { nodaDeleted: false });
    expect(await retireReplacedEdition(NEW_ID, w.deps)).toBe('retired');
    expect(w.docs.get(OLD_ID)!.noda_status).toBe('retired');
  });

  it('옛 판의 NODA 상태가 NULL이거나 파일 이름이 없으면 NODA를 건너뛰고 retired만', async () => {
    const a = world([row(), oldRow({ noda_status: null as never })]);
    expect(await retireReplacedEdition(NEW_ID, a.deps)).toBe('retired');
    expect(a.nodaDeletes).toEqual([]);
    const b = world([row(), oldRow({ noda_filename: null })]);
    expect(await retireReplacedEdition(NEW_ID, b.deps)).toBe('retired');
    expect(b.nodaDeletes).toEqual([]);
  });

  it('옛 판이 failed(NODA에 사본이 없을 수 있음)여도 NODA 404를 거쳐 retired', async () => {
    const w = world([row(), oldRow({ noda_status: 'failed' })], { nodaDeleted: false });
    expect(await retireReplacedEdition(NEW_ID, w.deps)).toBe('retired');
  });
});

describe('commonReadingDeps', () => {
  it('tenantOf — 유형 열쇠 보관함, 유형 밖이면 null', () => {
    const deps = commonReadingDeps();
    expect(deps.tenantOf({ org_type: '지방자치단체' })).toBe('workon-c-local');
    expect(deps.tenantOf({ org_type: '일반기업' })).toBe('workon-c-company');
    expect(deps.tenantOf({ org_type: '외계인' })).toBeNull();
    expect(deps.tenantOf({ org_type: null })).toBeNull();
    expect(deps.tenantOf({ agent_id: 'x' })).toBeNull();
  });
  it('ready 뒤 갈고리가 있다', () => {
    expect(typeof commonReadingDeps().afterReady).toBe('function');
  });
});

describe('deleteCommonDocument', () => {
  it('NODA → 행 → 원본 순서', async () => {
    const w = world([row({ noda_status: 'ready', replaces_id: null })]);
    expect(await deleteCommonDocument(NEW_ID, w.deps)).toEqual({ ok: true });
    expect(w.calls).toEqual([`noda:${row().noda_filename}`, `deleteRow:${NEW_ID}`, 'removeFile:common/local/new.pdf']);
    expect(w.nodaDeletes[0].tenant).toBe('workon-c-local');
  });
  it('NODA 실패면 deleting + 502, 행과 원본은 남는다', async () => {
    const w = world([row({ replaces_id: null })], { nodaFails: new NodaError('boom', 'http', 500) });
    expect(await deleteCommonDocument(NEW_ID, w.deps)).toEqual({ ok: false, status: 502 });
    expect(w.calls).toEqual([`noda:${row().noda_filename}`, `markDeleting:${NEW_ID}`]);
    expect(w.docs.get(NEW_ID)!.noda_status).toBe('deleting');
    expect(JSON.stringify(w.log.mock.calls)).not.toContain('여비');
  });
  it('retired·NULL 상태 행은 NODA를 건너뛴다', async () => {
    const a = world([row({ noda_status: 'retired', retired_at: '2026-01-01T00:00:00Z', replaces_id: null })]);
    expect(await deleteCommonDocument(NEW_ID, a.deps)).toEqual({ ok: true });
    expect(a.nodaDeletes).toEqual([]);
    expect(a.calls).toEqual([`deleteRow:${NEW_ID}`, 'removeFile:common/local/new.pdf']);
    const b = world([row({ noda_status: null as never, replaces_id: null })]);
    expect(await deleteCommonDocument(NEW_ID, b.deps)).toEqual({ ok: true });
    expect(b.nodaDeletes).toEqual([]);
  });
  it('NODA 파일 이름이 없으면 NODA를 건너뛴다', async () => {
    const w = world([row({ noda_filename: null, replaces_id: null })]);
    expect(await deleteCommonDocument(NEW_ID, w.deps)).toEqual({ ok: true });
    expect(w.nodaDeletes).toEqual([]);
  });
  it('행이 없으면 404', async () => {
    const w = world([]);
    expect(await deleteCommonDocument(NEW_ID, w.deps)).toEqual({ ok: false, status: 404 });
  });
  it('deleting 행은 다시 지울 수 있다(NODA를 다시 부른다)', async () => {
    const w = world([row({ noda_status: 'deleting', replaces_id: null })]);
    expect(await deleteCommonDocument(NEW_ID, w.deps)).toEqual({ ok: true });
    expect(w.nodaDeletes).toHaveLength(1);
  });
  it('NODA 404는 지운 것', async () => {
    const w = world([row({ replaces_id: null })], { nodaDeleted: false });
    expect(await deleteCommonDocument(NEW_ID, w.deps)).toEqual({ ok: true });
  });
  it('행 삭제가 실패하면 원본을 지우지 않는다', async () => {
    const w = world([row({ replaces_id: null })]);
    w.deps.store.deleteRow = async () => false;
    expect(await deleteCommonDocument(NEW_ID, w.deps)).toEqual({ ok: false, status: 502 });
    expect(w.removed).toEqual([]);
  });
});
