// tests/batch-0316.test.ts
// 비서 데이터 파일 미리 읽어 두기(2026-11-26) — 한 번 읽은 표를 저장소에 두고 다음부터 그것을, 5분 실행기가 아직 안 읽은 파일을 미리.
import { readFileSync } from 'fs';
import { gzipSync } from 'zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, Buffer>();
const uploads: string[] = [];
const downloads: string[] = [];
let docRow: Record<string, unknown> | null = null;
let failOriginal = false;
vi.mock('@/lib/supabaseAdmin', () => {
  const blob = (b: Buffer) => ({ size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) });
  const bucket = {
    download: async (path: string) => {
      downloads.push(path);
      if (path.startsWith('orig/') && failOriginal) return { data: null, error: { message: 'x' } };
      const b = storage.get(path);
      return b ? { data: blob(b), error: null } : { data: null, error: { message: 'not found' } };
    },
    upload: async (path: string, body: Buffer) => { uploads.push(path); storage.set(path, Buffer.from(body)); return { error: null }; },
  };
  const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: docRow, error: null }) };
  return { supabaseAdmin: { from: () => chain, storage: { from: () => bucket } } };
});

import {
  DATA_EXTRACT_VERSION, DATA_FILE_MAX_BYTES, DATA_PREFILL_BATCH, dataExtractPath, decodeDataExtract, encodeDataExtract, loadAgentDataExtract, prefillDataExtracts,
  type AgentDataFile, type DataPrefillDeps,
} from '@/lib/capabilities/agent-data-files';

const DOC = '11111111-1111-4111-8111-111111111111';
const FILE: AgentDataFile = { ref: 'd1', id: DOC, fileName: '집행.csv', title: null };
const csv = Buffer.from('부서,집행액\n총무과,100\n기획과,50\n', 'utf8');

beforeEach(() => {
  storage.clear(); uploads.length = 0; downloads.length = 0; failOriginal = false;
  docRow = { storage_path: 'orig/a.csv', file_name: '집행.csv', noda_status: 'ready', retired_at: null };
  storage.set('orig/a.csv', csv);
});

describe('읽어 둔 표의 꼴', () => {
  it('경로는 문서 id로만', () => {
    expect(dataExtractPath(DOC.toUpperCase())).toBe(`data-extracts/${DOC}.json`);
    expect(() => dataExtractPath('../x')).toThrow();
  });
  it('gzip JSON — 판이 다르거나 꼴이 틀리면 버림, 다시 해도 같은 실패도 담음', () => {
    const ok = encodeDataExtract({ ok: true, extract: { kind: 'csv', text: '', tables: [], warnings: [] } as never });
    expect(ok[0]).toBe(0x1f);
    expect(decodeDataExtract(ok)).toMatchObject({ ok: true });
    expect(decodeDataExtract(encodeDataExtract({ ok: false, message: '너무 큼' }))).toEqual({ ok: false, message: '너무 큼' });
    expect(decodeDataExtract(gzipSync(Buffer.from(JSON.stringify({ v: DATA_EXTRACT_VERSION + 1, extract: { tables: [] } }))))).toBeNull();
    expect(decodeDataExtract(Buffer.from(JSON.stringify({ v: DATA_EXTRACT_VERSION, extract: { tables: [] } })))).toMatchObject({ ok: true });
    expect(decodeDataExtract(Buffer.from(JSON.stringify({ v: DATA_EXTRACT_VERSION, extract: { tables: 3 } })))).toBeNull();
    expect(decodeDataExtract(Buffer.from('깨진'))).toBeNull();
  });
});

describe('loadAgentDataExtract', () => {
  it('처음엔 원본을 읽고 읽어 두며, 다음엔 원본을 내려받지 않는다', async () => {
    const first = await loadAgentDataExtract('org', 'agent', FILE);
    expect(first.ok).toBe(true);
    expect(uploads).toEqual([`data-extracts/${DOC}.json`]);
    expect(downloads).toContain('orig/a.csv');
    downloads.length = 0;
    const second = await loadAgentDataExtract('org', 'agent', FILE);
    expect(second).toEqual(first);
    expect(downloads).toEqual([`data-extracts/${DOC}.json`]);
  });
  it('원본을 잠깐 못 받으면 읽어 두지 않는다(다음에 다시), 너무 큰 파일은 그 실패를 읽어 둔다', async () => {
    failOriginal = true;
    expect((await loadAgentDataExtract('org', 'agent', FILE)).ok).toBe(false);
    expect(uploads).toEqual([]);
    failOriginal = false;
    storage.set('orig/a.csv', Buffer.alloc(DATA_FILE_MAX_BYTES + 1));
    const big = await loadAgentDataExtract('org', 'agent', FILE);
    expect(big).toMatchObject({ ok: false, message: expect.stringContaining('MB를 넘어') });
    expect(uploads).toHaveLength(1);
    downloads.length = 0;
    expect(await loadAgentDataExtract('org', 'agent', FILE)).toEqual(big);
    expect(downloads).not.toContain('orig/a.csv');
  });
  it('지금 쓸 수 없는 문서면 읽어 둔 표도 열지 않는다', async () => {
    await loadAgentDataExtract('org', 'agent', FILE);
    downloads.length = 0;
    docRow = { ...docRow, retired_at: '2026-11-26T00:00:00Z' };
    expect((await loadAgentDataExtract('org', 'agent', FILE)).ok).toBe(false);
    expect(downloads).toEqual([]);
    docRow = null;
    expect((await loadAgentDataExtract('org', 'agent', FILE)).ok).toBe(false);
  });
});

describe('prefillDataExtracts', () => {
  const agent = (n: number) => ({ id: `22222222-2222-4222-8222-22222222222${n}`, organization_id: '33333333-3333-4333-8333-333333333333' });
  const file = (n: number): AgentDataFile => ({ ref: `d${n}`, id: `44444444-4444-4444-8444-44444444444${n}`, fileName: 'a.csv', title: null });
  function deps(over: Partial<DataPrefillDeps> = {}) {
    const load = vi.fn(async () => ({ ok: true as const, extract: { tables: [] } as never }));
    const d: DataPrefillDeps = {
      listAgents: async () => [agent(1)],
      listFiles: async () => [file(1), file(2), file(3)],
      hasExtract: async (id) => id === file(1).id,
      load, now: () => 0, random: () => 0, ...over,
    };
    return { d, load };
  }
  it('아직 읽어 두지 않은 파일만, 한 차례에 둘까지', async () => {
    const { d, load } = deps();
    expect(await prefillDataExtracts(d)).toEqual({ filled: DATA_PREFILL_BATCH, failed: 0, checked: 3 });
    expect(load.mock.calls.map((c) => (c as unknown[])[2])).toEqual([file(2), file(3)]);
  });
  it('던지지 않는다 — 비서 목록 실패는 빈 차례, 확인 실패는 건너뜀, 읽기 실패는 셈', async () => {
    expect(await prefillDataExtracts(deps({ listAgents: async () => { throw new Error('x'); } }).d)).toEqual({ filled: 0, failed: 0, checked: 0 });
    const skip = deps({ hasExtract: async () => { throw new Error('x'); } });
    expect((await prefillDataExtracts(skip.d)).filled).toBe(0);
    expect(skip.load).not.toHaveBeenCalled();
    const bad = deps({ load: vi.fn(async () => ({ ok: false as const, message: 'x' })) });
    expect(await prefillDataExtracts(bad.d)).toMatchObject({ filled: 0, failed: 2 });
    const listFail = deps({ listFiles: async () => { throw new Error('x'); } });
    expect(await prefillDataExtracts(listFail.d)).toEqual({ filled: 0, failed: 0, checked: 0 });
  });
  it('시간이 다 되면 멈춘다', async () => {
    let t = 0;
    const { d, load } = deps({ now: () => (t += 30_000) });
    await prefillDataExtracts(d);
    expect(load).not.toHaveBeenCalled();
  });
});

describe('연결', () => {
  it('5분 실행기가 미리 읽고, 문서·비서를 지우면 읽어 둔 표도 지운다', () => {
    const cron = readFileSync('src/app/api/cron/app-schedules/route.ts', 'utf8');
    expect(cron).toContain('prefillDataExtracts(dataPrefillDeps()).catch(() => null)');
    expect(readFileSync('src/lib/document-delete.ts', 'utf8')).toContain('await removeDataExtracts([doc.id]);');
    expect(readFileSync('src/lib/agent-documents.ts', 'utf8')).toContain('(deps.store.removeDataExtracts ?? removeDataExtracts)(toDelete.map((r) => r.id))');
  });
});
